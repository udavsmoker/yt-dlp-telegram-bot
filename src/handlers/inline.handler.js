const inlineService = require('../services/inline.service');
const spotifyAudioService = require('../services/spotify-audio.service');
const spotifyService = require('../services/spotify.service');
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

/**
 * Background worker to download, tag, and deliver an inline music track to chat.
 * Replaces the temporary "Downloading..." article message with full audio player.
 * @param {object} ctx
 * @param {string} resultId
 * @param {string} inlineMessageId
 * @param {string} botUsername
 */
async function processInlineMusicDownload(ctx, resultId, inlineMessageId, botUsername) {
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
      track = {
        id: `yt_${youtubeId}`,
        youtubeId,
        title: 'Track',
        artist: 'Music',
        album: 'Single',
        durationMs: 0
      };
    }
  }

  if (!track) {
    logger.warn(`No metadata found for inline music download: ${resultId}`);
    return;
  }

  logger.info(`Starting automatic inline download for "${track.title}" by "${track.artist}" (resultId: ${resultId})`);
  let result = null;

  try {
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
        // If DM to user failed (e.g. 403 Forbidden), fallback to admin user
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
          caption: `🎵 <b>${escapeHtml(result.title)}</b> — <i>${escapeHtml(result.artist)}</i>\nvia @${botUsername}`,
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
    if (result?.audioPath) await cleanupFile(result.audioPath);
    if (result?.thumbnailPath) await cleanupFile(result.thumbnailPath);
  }
}

/**
 * Handle chosen inline result event.
 * Automatically initiates track synthesis and delivers audio to the chat.
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
  }
}

/**
 * Handle inline button click (inline_wait:*).
 * Shows a toast alert confirming that download is actively in progress.
 * @param {object} ctx
 */
async function handleInlineDownloadCallback(ctx) {
  await ctx.answerCbQuery('⏳ Track is being downloaded and converted to 320 kbps MP3...\nPlease wait a few seconds!', {
    show_alert: false
  });
}

module.exports = {
  handleInlineQuery,
  handleChosenInlineResult,
  handleInlineDownloadCallback
};
