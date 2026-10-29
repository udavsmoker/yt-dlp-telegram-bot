const spotifyService = require('../services/spotify.service');
const spotifyAudioService = require('../services/spotify-audio.service');
const queueService = require('../services/queue.service');
const undoService = require('../services/undo.service');
const cacheService = require('../services/cache.service');
const { tryServeFromCache, cacheSentMedia } = require('./download/common/cache-helper');
const logger = require('../utils/logger');
const { getFileForTelegram, renderProgressBar, getUserInfo, formatDuration } = require('../utils/helpers');
const { getSenderInfo } = require('./download/common/telegram-sender');
const { downloadLimiter } = require('../middleware/rate-limit.middleware');

// In-memory cache for active search prompts (searchId -> search session)
const pendingSearches = new Map();

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Handle song search command (/song, /music, /track, /search) or direct query text.
 * @param {object} ctx - Telegraf context
 * @param {string|null} [directQuery=null]
 */
async function handleSearchCommand(ctx, directQuery = null) {
  let query = typeof directQuery === 'string' ? directQuery.trim() : null;

  if (!query) {
    const text = ctx.message?.text || '';
    query = text.replace(/^\/(?:music|song|track|find|search)(?:@\w+)?\s*/i, '').trim();
  }

  // If no search term provided, show helpful instruction guide
  if (!query) {
    const helpText = [
      '🔍 <b>Music Search</b>',
      '',
      'Send <code>/song &lt;title or artist&gt;</code> to find and download any song directly.',
      '',
      '<b>Examples:</b>',
      '• <code>/song Bohemian Rhapsody</code>',
      '• <code>/song Miyagi Minor</code>',
      '• <code>/song Linkin Park Numb</code>',
      '• <code>/song Король и Шут Лесник</code>',
      '',
      '<i>💡 In private chat with the bot, you can simply type the song title directly!</i>'
    ].join('\n');

    return ctx.reply(helpText, { parse_mode: 'HTML' });
  }

  return executeSearch(ctx, query, ctx.message?.message_id);
}

/**
 * Execute search query, fetch results, and present interactive inline keyboard.
 * @param {object} ctx
 * @param {string} query
 * @param {number|null} triggerMessageId
 */
async function executeSearch(ctx, query, triggerMessageId = null) {
  const userId = ctx.from?.id;
  const userInfo = getUserInfo(ctx);

  if (userId) {
    const rateLimit = downloadLimiter.check(String(userId));
    if (rateLimit.limited) {
      return ctx.reply('⏱ Please wait a moment before making another request.');
    }
  }

  logger.info(`Song search initiated by ${userInfo}: "${query}"`);

  const statusMessage = await ctx.reply(`🔎 Searching for "<b>${escapeHtml(query)}</b>"...`, { parse_mode: 'HTML' });

  try {
    const tracks = await spotifyService.searchTracks(query, 5);

    if (!tracks || tracks.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        `❌ No songs found for "<b>${escapeHtml(query)}</b>". Try a different query.`,
        { parse_mode: 'HTML' }
      );
      const delTimer = setTimeout(() => {
        ctx.telegram?.deleteMessage?.(ctx.chat.id, statusMessage.message_id).catch(() => {});
      }, 10000);
      if (typeof delTimer?.unref === 'function') delTimer.unref();
      return;
    }

    const searchId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

    pendingSearches.set(searchId, {
      userId,
      chatId: ctx.chat.id,
      query,
      tracks,
      statusMessageId: statusMessage.message_id,
      triggerMessageId,
      timestamp: Date.now()
    });

    const expireTimer = setTimeout(() => {
      if (pendingSearches.has(searchId)) {
        pendingSearches.delete(searchId);
        ctx.telegram?.deleteMessage?.(ctx.chat.id, statusMessage.message_id).catch(() => {});
      }
    }, 300000);
    if (typeof expireTimer?.unref === 'function') expireTimer.unref();

    const lines = [
      `🔍 <b>Search results for:</b> "<i>${escapeHtml(query)}</i>"`,
      ''
    ];

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const emoji = NUMBER_EMOJIS[i] || `${i + 1}.`;
      const durStr = t.durationMs ? ` • ⏱ ${formatDuration(Math.round(t.durationMs / 1000))}` : '';
      const albumStr = t.album ? `💿 <i>${escapeHtml(t.album)}</i>` : '';
      const meta = albumStr ? `   ${albumStr}${durStr}` : (durStr ? `   ⏱ ${durStr.replace(' • ⏱ ', '')}` : '');

      lines.push(`${emoji} <b>${escapeHtml(t.title)}</b> — ${escapeHtml(t.artist)}`);
      if (meta) lines.push(meta);
      lines.push('');
    }

    lines.push('<i>Choose a track to download:</i>');

    // Build responsive 2-column inline buttons for quick selection
    const keyboard = [];
    for (let i = 0; i < tracks.length; i += 2) {
      const row = [];
      const t1 = tracks[i];
      const label1 = `${NUMBER_EMOJIS[i] || (i + 1)} ${t1.title.length > 20 ? t1.title.substring(0, 18) + '…' : t1.title}`;
      row.push({ text: label1, callback_data: `s_dl_${searchId}_${i}` });

      if (i + 1 < tracks.length) {
        const t2 = tracks[i + 1];
        const label2 = `${NUMBER_EMOJIS[i + 1] || (i + 2)} ${t2.title.length > 20 ? t2.title.substring(0, 18) + '…' : t2.title}`;
        row.push({ text: label2, callback_data: `s_dl_${searchId}_${i + 1}` });
      }
      keyboard.push(row);
    }

    keyboard.push([{ text: '❌ Cancel', callback_data: `s_cancel_${searchId}` }]);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      }
    );
  } catch (err) {
    logger.error(`Error executing song search for "${query}":`, err);
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        `⚠️ Failed to search for "${escapeHtml(query)}": ${escapeHtml(err.message)}`,
        { parse_mode: 'HTML' }
      );
      const errTimer = setTimeout(() => {
        ctx.telegram?.deleteMessage?.(ctx.chat.id, statusMessage.message_id).catch(() => {});
      }, 8000);
      if (typeof errTimer?.unref === 'function') errTimer.unref();
    } catch {}
  }
}

/**
 * Handle button clicks for song selection and cancellation.
 * @param {object} ctx
 */
async function handleSearchCallback(ctx) {
  const data = ctx.callbackQuery?.data;
  const userId = ctx.from?.id;

  if (!data) return;

  // 1. Cancel search prompt
  if (data.startsWith('s_cancel_')) {
    const searchId = data.replace('s_cancel_', '');
    const session = pendingSearches.get(searchId);

    if (session && session.userId && session.userId !== userId) {
      return ctx.answerCbQuery('⚠️ Only the person who searched can cancel.', { show_alert: true });
    }

    pendingSearches.delete(searchId);
    await ctx.answerCbQuery('❌ Search cancelled');
    if (typeof ctx.deleteMessage === 'function') {
      return ctx.deleteMessage().catch(() => {});
    }
    return;
  }

  // 2. Select track for download
  if (data.startsWith('s_dl_')) {
    const lastUnderscore = data.lastIndexOf('_');
    const index = parseInt(data.substring(lastUnderscore + 1), 10);
    const searchId = data.substring('s_dl_'.length, lastUnderscore);

    const session = pendingSearches.get(searchId);
    if (!session) {
      await ctx.answerCbQuery('⚠️ This search has expired.');
      if (typeof ctx.deleteMessage === 'function') {
        return ctx.deleteMessage().catch(() => {});
      }
      return;
    }

    if (session.userId && session.userId !== userId) {
      return ctx.answerCbQuery('⚠️ Only the person who searched can choose a song.', { show_alert: true });
    }

    const track = session.tracks[index];
    if (!track) {
      await ctx.answerCbQuery('⚠️ Track not found.');
      return;
    }

    pendingSearches.delete(searchId);
    await ctx.answerCbQuery(`🎵 Starting download: "${track.title}"...`);

    const userInfo = getUserInfo(ctx);
    downloadSelectedTrack(ctx, track, session.statusMessageId, session.triggerMessageId, userInfo).catch(err => {
      logger.error(`Error downloading searched track "${track.title}" for ${userInfo}:`, err);
    });
  }
}

/**
 * Download selected track and send directly to Telegram chat.
 * @param {object} ctx
 * @param {object} track
 * @param {number} statusMessageId
 * @param {number|null} triggerMessageId
 * @param {string} userInfo
 */
async function downloadSelectedTrack(ctx, track, statusMessageId, triggerMessageId, userInfo) {
  const canonicalUrl = track.id ? `https://open.spotify.com/track/${track.id}` : null;
  if (canonicalUrl && await tryServeFromCache(ctx, canonicalUrl, statusMessageId, triggerMessageId, userInfo, 'audio')) {
    return;
  }

  await queueService.enqueue(async ({ signal } = {}) => {
    const progressReporter = queueService.createProgressReporter(ctx, statusMessageId);
    const onProgress = ({ percent, speed, eta }) => {
      progressReporter.update(renderProgressBar(percent, speed, eta));
    };

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessageId,
        null,
        `⬇️ Downloading "<b>${escapeHtml(track.title)}</b>" by ${escapeHtml(track.artist)}...`,
        { parse_mode: 'HTML' }
      );

      const result = await spotifyAudioService.downloadAndTagTrack(track, { signal, onProgress });
      progressReporter.stop();

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessageId,
        null,
        '📤 Uploading to Telegram...'
      );

      const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
      const audioOpts = {
        title: result.title,
        performer: result.artist,
        duration: result.duration
      };

      if (isGroup) {
        const sender = getSenderInfo(ctx);
        audioOpts.caption = `Sent by ${sender.caption}`;
        audioOpts.parse_mode = 'HTML';
      }

      if (result.thumbnailPath) {
        audioOpts.thumbnail = getFileForTelegram(result.thumbnailPath);
      }

      const sentAudio = await ctx.replyWithAudio(
        getFileForTelegram(result.audioPath),
        audioOpts
      );

      if (sentAudio && ctx.chat?.id) {
        undoService.record(ctx.chat.id, [sentAudio.message_id], ctx.from?.id);
        if (canonicalUrl) {
          cacheSentMedia(canonicalUrl, [sentAudio], {
            platform: 'Spotify',
            title: result.title,
            author: result.artist,
            duration: result.duration
          }, {
            duration: result.duration,
            fileSize: result.fileSize
          });
        }
      }

      await result.cleanup();

      // Clean up status message and original search command message
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMessageId);
      } catch {}
      if (triggerMessageId) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, triggerMessageId);
        } catch {}
      }

      logger.info(`Searched track "${track.title}" sent successfully to ${userInfo}`);
    } catch (err) {
      if (err.message === 'DOWNLOAD_CANCELLED' || signal?.aborted) {
        logger.info(`Track download "${track.title}" cancelled for ${userInfo}`);
        return;
      }
      logger.error(`Failed to download searched track "${track.title}":`, err);
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessageId,
          null,
          `⚠️ Download failed: ${escapeHtml(err.message)}`
        );
        const failTimer = setTimeout(() => {
          ctx.telegram?.deleteMessage?.(ctx.chat.id, statusMessageId).catch(() => {});
        }, 8000);
        if (typeof failTimer?.unref === 'function') failTimer.unref();
      } catch {}
    } finally {
      progressReporter.stop();
    }
  }, { ctx, statusMessageId, originalMessageId: triggerMessageId });
}

/**
 * Cancel a pending search prompt for /cancel command integration.
 * @param {string|number} chatId
 * @param {number|null} targetMessageId
 * @param {number|null} userId
 * @param {boolean} isChatAdmin
 * @returns {{ messageId: number } | { unauthorized: true } | null}
 */
function cancelPendingSearch(chatId, targetMessageId = null, userId = null, isChatAdmin = false) {
  const keyChatId = Number(chatId);
  const parsedTargetId = targetMessageId ? Number(targetMessageId) : null;
  const parsedUserId = userId ? Number(userId) : null;

  for (const [searchId, session] of Array.from(pendingSearches.entries()).reverse()) {
    if (session.chatId && Number(session.chatId) !== keyChatId) continue;
    if (parsedTargetId && session.statusMessageId !== parsedTargetId) continue;

    const isOwner = parsedUserId && session.userId === parsedUserId;
    if (!isChatAdmin && !isOwner && session.userId) {
      return { unauthorized: true };
    }

    pendingSearches.delete(searchId);
    return { messageId: session.statusMessageId };
  }

  return null;
}

module.exports = {
  handleSearchCommand,
  handleSearchCallback,
  cancelPendingSearch,
  pendingSearches
};
