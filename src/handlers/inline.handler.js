const axios = require('axios');
const inlineService = require('../services/inline.service');
const spotifyAudioService = require('../services/spotify-audio.service');
const spotifyService = require('../services/spotify.service');
const videoService = require('../services/video.service');
const cacheService = require('../services/cache.service');
const config = require('../config');
const logger = require('../utils/logger');
const { getFileForTelegram, cleanupFile, escapeHtml, getUserInfo } = require('../utils/helpers');

/**
 * Handle incoming Telegram inline queries (@bot <query>).
 * @param {object} ctx - Telegraf context
 */
async function handleInlineQuery(ctx) {
  const query = ctx.inlineQuery?.query || '';
  const botUsername = ctx.botInfo?.username || 'bot';

  try {
    const results = await inlineService.handleQuery(query, botUsername);

    await ctx.answerInlineQuery(results, {
      cache_time: 60,
      is_personal: false
    });
  } catch (err) {
    logger.error(`Inline query failed for "${query}": ${err.message}`);
    try {
      await ctx.answerInlineQuery([], { cache_time: 10 });
    } catch {}
  }
}

// Concurrency tracking to prevent overlapping downloads for the same inline message
const activeInlineDownloads = new Set();

/**
 * Background worker to download, tag, and deliver an inline music track directly to chat.
 * Replaces the temporary "Downloading..." article message with full audio player.
 * @param {object} ctx
 * @param {string} resultId
 * @param {string} inlineMessageId
 * @param {string} botUsername
 */
async function processInlineMusicDownload(ctx, resultId, inlineMessageId, botUsername) {
  if (inlineMessageId) {
    if (activeInlineDownloads.has(inlineMessageId)) {
      logger.info(`Inline music download already in progress for message: ${inlineMessageId}`);
      return;
    }
    activeInlineDownloads.add(inlineMessageId);
  }

  let track = inlineService.getPendingTrack(resultId);

  // If track not found in memory (e.g. server restart), resolve metadata on-demand
  if (!track) {
    if (resultId.startsWith('spot_')) {
      const spotId = resultId.replace('spot_', '');
      try {
        const spotifyMeta = await spotifyService.getTrack(spotId);
        if (spotifyMeta) {
          track = {
            id: `spot_${spotId}`,
            spotifyId: spotId,
            title: spotifyMeta.title,
            artist: spotifyMeta.artist,
            album: spotifyMeta.album || spotifyMeta.title,
            coverUrl: spotifyMeta.coverUrl,
            durationMs: spotifyMeta.durationMs || 0
          };
        }
      } catch (err) {
        logger.warn(`Could not resolve Spotify fallback track: ${err.message}`);
      }
    } else if (resultId.startsWith('song_')) {
      const youtubeId = resultId.replace('song_', '');
      let title = 'Track';
      let artist = 'Music';
      let coverUrl = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`;
        const res = await axios.get(oembedUrl, { timeout: 2500 });
        if (res.data?.title) {
          title = res.data.title;
          artist = res.data.author_name || 'Music';
          if (title.includes(' - ')) {
            const parts = title.split(' - ');
            artist = parts[0].trim();
            title = parts.slice(1).join(' - ').replace(/\s*\(Official.*?\)/i, '').replace(/\s*\[Official.*?\]/i, '').trim();
          }
        }
        if (res.data?.thumbnail_url) coverUrl = res.data.thumbnail_url;
      } catch (err) {
        logger.warn(`Could not resolve YouTube oEmbed fallback track: ${err.message}`);
      }

      track = {
        id: `yt_${youtubeId}`,
        youtubeId,
        title,
        artist,
        album: title,
        coverUrl,
        durationMs: 0
      };
    }
  }

  if (!track) {
    logger.warn(`No metadata found for inline music download: ${resultId}`);
    return;
  }

  logger.info(`Starting automatic inline music download for "${track.title}" by "${track.artist}"`);
  let result = null;

  try {
    if (inlineMessageId) {
      await ctx.telegram.editMessageReplyMarkup(undefined, undefined, inlineMessageId, {
        inline_keyboard: [
          [
            { text: '⏳ Скачивание 320k MP3...', callback_data: 'inline_wait:busy' }
          ]
        ]
      }).catch(() => {});
    }

    result = await spotifyAudioService.downloadAndTagTrack(track);

    // Obtain Telegram file_id to edit the inline message
    let fileId = null;
    const recipientId = ctx.from?.id || config.adminUserId;

    if (recipientId) {
      try {
        const sent = await ctx.telegram.sendAudio(recipientId, getFileForTelegram(result.audioPath), {
          title: result.title,
          performer: result.artist,
          duration: result.duration,
          caption: `🎵 <b>${escapeHtml(result.title)}</b> — <i>${escapeHtml(result.artist)}</i>\nvia @${botUsername}`,
          parse_mode: 'HTML',
          ...(result.thumbnailPath ? { thumbnail: getFileForTelegram(result.thumbnailPath) } : {})
        });

        if (sent?.audio?.file_id) {
          fileId = sent.audio.file_id;
        }
      } catch (dmErr) {
        // Fallback to admin user if sending to recipient DM is blocked
        if (config.adminUserId && recipientId !== config.adminUserId) {
          try {
            const adminSent = await ctx.telegram.sendAudio(config.adminUserId, getFileForTelegram(result.audioPath), {
              title: result.title,
              performer: result.artist,
              duration: result.duration,
              caption: `🎵 <b>${escapeHtml(result.title)}</b> — <i>${escapeHtml(result.artist)}</i>\nvia @${botUsername}`,
              parse_mode: 'HTML',
              ...(result.thumbnailPath ? { thumbnail: getFileForTelegram(result.thumbnailPath) } : {})
            });
            if (adminSent?.audio?.file_id) {
              fileId = adminSent.audio.file_id;
            }
          } catch (adminErr) {
            logger.warn(`Fallback audio upload to admin failed: ${adminErr.message}`);
          }
        }
      }
    }

    if (fileId) {
      // Replace the inline placeholder message with native Telegram audio player
      await ctx.telegram.editMessageMedia(
        undefined, undefined, inlineMessageId,
        {
          type: 'audio',
          media: fileId,
          caption: `🎵 <b>${escapeHtml(result.title)}</b> — <i>${escapeHtml(result.artist)}</i>`,
          parse_mode: 'HTML'
        }
      );

      // Cache file_id in SQLite for instant future responses
      const targetUrl = track.spotifyId
        ? `https://open.spotify.com/track/${track.spotifyId}`
        : `https://www.youtube.com/watch?v=${track.youtubeId || track.id}`;

      cacheService.set(targetUrl, {
        fileId: fileId,
        fileType: 'audio',
        title: result.title,
        author: result.artist,
        duration: String(result.duration || 0),
        fileSize: result.fileSize
      });

      logger.info(`Successfully delivered inline audio "${result.title}" to message ${inlineMessageId}`);
    } else {
      logger.warn(`Could not obtain file_id for inline audio "${result.title}"`);
    }
  } catch (err) {
    logger.error(`Failed to process inline track download for "${track.title}": ${err.message}`);
    try {
      await ctx.telegram.editMessageText(
        undefined, undefined, inlineMessageId,
        `❌ <b>Download Failed:</b> ${escapeHtml(err.message)}`,
        { parse_mode: 'HTML' }
      );
    } catch {}
  } finally {
    if (inlineMessageId) activeInlineDownloads.delete(inlineMessageId);
    if (result?.audioPath) await cleanupFile(result.audioPath);
    if (result?.thumbnailPath) await cleanupFile(result.thumbnailPath);
  }
}

/**
 * Background worker to download and deliver an inline video (Instagram, YouTube, generic) to chat.
 * Replaces the temporary "Downloading..." article message with native video player.
 * @param {object} ctx
 * @param {string} resultId
 * @param {string} inlineMessageId
 * @param {string} botUsername
 */
async function processInlineVideoDownload(ctx, resultId, inlineMessageId, botUsername) {
  if (inlineMessageId) {
    if (activeInlineDownloads.has(inlineMessageId)) {
      logger.info(`Inline video download already in progress for message: ${inlineMessageId}`);
      return;
    }
    activeInlineDownloads.add(inlineMessageId);
  }

  const shortToken = resultId.replace(/^(?:ig|yt|gen)_/, '');
  const url = inlineService.getShortLink(shortToken);

  if (!url) {
    logger.warn(`No URL found for inline video token: ${shortToken}`);
    if (inlineMessageId) activeInlineDownloads.delete(inlineMessageId);
    return;
  }

  logger.info(`Starting automatic inline video download for ${url} (resultId: ${resultId})`);
  let result = null;

  try {
    if (inlineMessageId) {
      await ctx.telegram.editMessageReplyMarkup(undefined, undefined, inlineMessageId, {
        inline_keyboard: [
          [
            { text: '⏳ Скачивание видео...', callback_data: 'inline_wait:busy' }
          ]
        ]
      }).catch(() => {});
    }

    result = await videoService.download(url);

    let fileId = null;
    const recipientId = ctx.from?.id || config.adminUserId;

    if (recipientId && result.filePath) {
      const videoCaption = `📹 <b>${escapeHtml(result.info?.title || 'Video')}</b>\nvia @${botUsername}`;
      const videoOpts = {
        caption: videoCaption,
        parse_mode: 'HTML',
        ...(result.thumbnailPath ? { thumbnail: getFileForTelegram(result.thumbnailPath) } : {}),
        ...(result.info?.width ? { width: result.info.width } : {}),
        ...(result.info?.height ? { height: result.info.height } : {}),
        ...(result.info?.duration ? { duration: result.info.duration } : {})
      };

      try {
        const sent = await ctx.telegram.sendVideo(recipientId, getFileForTelegram(result.filePath), videoOpts);
        if (sent?.video?.file_id) {
          fileId = sent.video.file_id;
        }
      } catch (dmErr) {
        if (config.adminUserId && recipientId !== config.adminUserId) {
          try {
            const adminSent = await ctx.telegram.sendVideo(config.adminUserId, getFileForTelegram(result.filePath), videoOpts);
            if (adminSent?.video?.file_id) {
              fileId = adminSent.video.file_id;
            }
          } catch (adminErr) {
            logger.warn(`Fallback video upload to admin failed: ${adminErr.message}`);
          }
        }
      }
    }

    if (fileId && inlineMessageId) {
      await ctx.telegram.editMessageMedia(
        undefined, undefined, inlineMessageId,
        {
          type: 'video',
          media: fileId,
          caption: `📹 <b>${escapeHtml(result.info?.title || 'Video')}</b>`,
          parse_mode: 'HTML'
        }
      );

      cacheService.set(url, {
        fileId: fileId,
        fileType: 'video',
        title: result.info?.title,
        author: result.info?.uploader,
        duration: String(result.info?.duration || 0),
        fileSize: result.fileSize
      });

      logger.info(`Successfully delivered inline video to message ${inlineMessageId}`);
    }
  } catch (err) {
    logger.error(`Failed to process inline video download for ${url}: ${err.message}`);
    if (inlineMessageId) {
      await ctx.telegram.editMessageText(
        undefined, undefined, inlineMessageId,
        `❌ <b>Download Failed:</b> ${escapeHtml(err.message)}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } finally {
    if (inlineMessageId) activeInlineDownloads.delete(inlineMessageId);
    if (result?.filePath) await cleanupFile(result.filePath);
    if (result?.thumbnailPath) await cleanupFile(result.thumbnailPath);
  }
}

/**
 * Handle chosen inline result event.
 * Automatically initiates media synthesis and delivers media directly to the chat.
 * @param {object} ctx
 */
async function handleChosenInlineResult(ctx) {
  const chosen = ctx.chosenInlineResult;
  if (!chosen) return;

  const resultId = chosen.result_id;
  const inlineMessageId = chosen.inline_message_id;
  const userInfo = getUserInfo(ctx);
  const botUsername = ctx.botInfo?.username || 'bot';

  logger.info(`Chosen inline result "${resultId}" by ${userInfo} (inlineMessageId: ${inlineMessageId || 'none'})`);

  if (!inlineMessageId) return;

  // Music tracks: automatically download and replace placeholder with audio
  if (resultId.startsWith('song_') || resultId.startsWith('spot_')) {
    processInlineMusicDownload(ctx, resultId, inlineMessageId, botUsername).catch(err => {
      logger.error(`Unhandled error in inline music processing: ${err.message}`);
    });
    return;
  }

  // Videos (Instagram, YouTube, generic): automatically download and replace placeholder with video
  if (resultId.startsWith('ig_') || resultId.startsWith('yt_') || resultId.startsWith('gen_')) {
    processInlineVideoDownload(ctx, resultId, inlineMessageId, botUsername).catch(err => {
      logger.error(`Unhandled error in inline video processing: ${err.message}`);
    });
  }
}

/**
 * Handle inline button click (inline_wait:* or inline_dl:*).
 * Initiates download if not yet started or shows status alert.
 * @param {object} ctx
 */
async function handleInlineDownloadCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  const inlineMessageId = ctx.callbackQuery?.inline_message_id;
  const botUsername = ctx.botInfo?.username || 'bot';

  // Format: inline_dl:<resultId> or inline_wait:<resultId>
  const targetId = data.replace(/^inline_(?:dl|wait):/, '');

  if (targetId === 'busy' || (inlineMessageId && activeInlineDownloads.has(inlineMessageId))) {
    await ctx.answerCbQuery('⏳ Скачивание уже идет, подождите пару секунд...', {
      show_alert: false
    }).catch(() => {});
    return;
  }

  await ctx.answerCbQuery('🚀 Начинаем скачивание медиа...', {
    show_alert: false
  }).catch(() => {});

  if (!inlineMessageId) return;

  // Music tracks: automatically download and replace placeholder with audio
  if (targetId.startsWith('song_') || targetId.startsWith('spot_') || (!targetId.includes('_') && targetId.length > 5)) {
    const fullId = targetId.startsWith('song_') || targetId.startsWith('spot_') ? targetId : `song_${targetId}`;
    processInlineMusicDownload(ctx, fullId, inlineMessageId, botUsername).catch(err => {
      logger.error(`Unhandled error in inline music processing via callback: ${err.message}`);
    });
    return;
  }

  // Videos (Instagram, YouTube, generic)
  if (targetId.startsWith('ig_') || targetId.startsWith('yt_') || targetId.startsWith('gen_')) {
    processInlineVideoDownload(ctx, targetId, inlineMessageId, botUsername).catch(err => {
      logger.error(`Unhandled error in inline video processing via callback: ${err.message}`);
    });
  }
}

module.exports = {
  handleInlineQuery,
  handleChosenInlineResult,
  handleInlineDownloadCallback
};
