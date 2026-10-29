const inlineService = require('../services/inline.service');
const spotifyAudioService = require('../services/spotify-audio.service');
const cacheService = require('../services/cache.service');
const { cacheSentMedia } = require('./download/common/cache-helper');
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
 * Handle chosen inline result event (for telemetry and metrics).
 * @param {object} ctx
 */
async function handleChosenInlineResult(ctx) {
  const chosen = ctx.chosenInlineResult;
  if (!chosen) return;
  const userInfo = getUserInfo(ctx);
  logger.info(`Chosen inline result "${chosen.result_id}" by ${userInfo} (query: "${chosen.query}")`);
}

/**
 * Handle inline download callback button (inline_dl:<youtubeId>).
 * @param {object} ctx
 */
async function handleInlineDownloadCallback(ctx) {
  const youtubeId = ctx.match?.[1];
  if (!youtubeId) return;

  const inlineMessageId = ctx.callbackQuery?.inline_message_id;
  const botUsername = ctx.botInfo?.username || 'bot';
  const ytUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
  const normalizedUrl = cacheService.normalizeUrl(ytUrl);

  await ctx.answerCbQuery('⏳ Processing 320 kbps MP3 download...');

  // 1. Check if track is already in SQLite cache
  const cached = cacheService.get(normalizedUrl);
  if (cached && cached.file_id && cached.file_type === 'audio') {
    if (inlineMessageId) {
      try {
        await ctx.telegram.editMessageMedia(
          undefined, undefined, inlineMessageId,
          {
            type: 'audio',
            media: cached.file_id,
            caption: `🎵 <b>${escapeHtml(cached.title)}</b> — <i>${escapeHtml(cached.author)}</i>\nvia @${botUsername}`,
            parse_mode: 'HTML'
          }
        );
        return;
      } catch (err) {
        logger.warn(`Failed to edit inline message with cached file_id: ${err.message}`);
      }
    }
  }

  // 2. Notify user in-place that download started
  if (inlineMessageId) {
    try {
      await ctx.telegram.editMessageText(
        undefined, undefined, inlineMessageId,
        '⏳ <b>Downloading & converting track to 320 kbps MP3...</b>\n<i>Please wait a moment.</i>',
        { parse_mode: 'HTML' }
      );
    } catch {}
  }

  let result = null;
  try {
    const trackPayload = {
      id: `yt_${youtubeId}`,
      youtubeId,
      title: 'Music Track',
      artist: 'YouTube',
      durationMs: 0
    };

    result = await spotifyAudioService.downloadAndTagTrack(trackPayload);

    // 3. Obtain Telegram file_id by delivering to user's private chat if possible
    let fileId = null;
    const userId = ctx.from?.id;
    if (userId) {
      try {
        const sent = await ctx.telegram.sendAudio(userId, getFileForTelegram(result.audioPath), {
          title: result.title,
          performer: result.artist,
          duration: result.duration,
          caption: `🎵 <b>${escapeHtml(result.title)}</b> — <i>${escapeHtml(result.artist)}</i>\nvia @${botUsername}`,
          parse_mode: 'HTML',
          ...(result.thumbnailPath ? { thumbnail: getFileForTelegram(result.thumbnailPath) } : {})
        });

        if (sent?.audio?.file_id) {
          fileId = sent.audio.file_id;
          cacheSentMedia(ytUrl, [sent], {
            platform: 'YouTube Music',
            title: result.title,
            author: result.artist,
            duration: result.duration
          }, { duration: result.duration, fileSize: result.fileSize });
        }
      } catch (dmErr) {
        logger.warn(`Could not deliver audio to DM ${userId}: ${dmErr.message}`);
      }
    }

    // 4. Update the inline message in the group with audio file_id or fallback link
    if (inlineMessageId) {
      if (fileId) {
        await ctx.telegram.editMessageMedia(
          undefined, undefined, inlineMessageId,
          {
            type: 'audio',
            media: fileId,
            caption: `🎵 <b>${escapeHtml(result.title)}</b> — <i>${escapeHtml(result.artist)}</i>\nvia @${botUsername}`,
            parse_mode: 'HTML'
          }
        ).catch(() => {});
      } else {
        await ctx.telegram.editMessageText(
          undefined, undefined, inlineMessageId,
          `✅ <b>"${escapeHtml(result.title)}" is ready!</b>\n\nClick below to listen and receive your MP3 in the bot:`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎧 Open & Listen in Bot', url: `https://t.me/${botUsername}?start=song_${youtubeId}` }]
              ]
            }
          }
        ).catch(() => {});
      }
    }
  } catch (err) {
    logger.error(`Inline track download failed for ${youtubeId}: ${err.message}`);
    if (inlineMessageId) {
      await ctx.telegram.editMessageText(
        undefined, undefined, inlineMessageId,
        `❌ <b>Download Failed:</b> ${escapeHtml(err.message)}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎧 Try in Bot', url: `https://t.me/${botUsername}?start=song_${youtubeId}` }]
            ]
          }
        }
      ).catch(() => {});
    }
  } finally {
    if (result?.audioPath) await cleanupFile(result.audioPath);
    if (result?.thumbnailPath) await cleanupFile(result.thumbnailPath);
  }
}

module.exports = {
  handleInlineQuery,
  handleChosenInlineResult,
  handleInlineDownloadCallback
};
