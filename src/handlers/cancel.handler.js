const queueService = require('../services/queue.service');
const { youtubeStrategy, spotifyStrategy } = require('./download');
const { cancelPendingSearch } = require('./search.handler');
const { isAdmin, getUserInfo, escapeHtml } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Handle /cancel command: cancel in-flight or queued download, or pending confirmation.
 * @param {object} ctx - Telegraf context
 */
async function handleCancel(ctx) {
  const userInfo = getUserInfo(ctx);
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const replyMessage = ctx.message?.reply_to_message;
  const targetMessageId = replyMessage?.message_id || null;
  const userId = ctx.from?.id;
  const isChatAdmin = await isAdmin(ctx);

  // 1. Check for active Spotify playlist download
  let spotActiveResult = null;
  if (spotifyStrategy && typeof spotifyStrategy.cancelActive === 'function') {
    spotActiveResult = spotifyStrategy.cancelActive(chatId, targetMessageId, userId, isChatAdmin);
    if (spotActiveResult && spotActiveResult.unauthorized) {
      return ctx.reply('⚠️ You can only cancel your own downloads. Ask a chat admin to cancel it.');
    }
  }

  // 2. Try cancelling active or queued download job in QueueService
  const cancelResult = queueService.cancelJob(chatId, targetMessageId, userId, isChatAdmin);

  if (cancelResult && cancelResult.unauthorized) {
    return ctx.reply('⚠️ You can only cancel your own downloads. Ask a chat admin to cancel it.');
  }

  if (spotActiveResult && spotActiveResult.statusMessageId) {
    logger.info(`Spotify playlist #${spotActiveResult.statusMessageId} cancelled by ${userInfo}`);

    // Delete user's /cancel command message
    try {
      await ctx.deleteMessage();
    } catch {}

    const title = spotActiveResult.title || 'Playlist';
    const sentCount = typeof spotActiveResult.getCompletedCount === 'function'
      ? spotActiveResult.getCompletedCount()
      : (spotActiveResult.completedCount || 0);
    const totalCount = spotActiveResult.total || 0;

    const cancelMsg = [
      `🛑 <b>Playlist download cancelled: ${escapeHtml(title)}</b>`,
      totalCount > 0 ? `Sent <b>${sentCount}/${totalCount}</b> tracks before cancellation.` : 'No tracks were sent.'
    ].join('\n');

    try {
      await ctx.telegram.editMessageText(chatId, spotActiveResult.statusMessageId, null, cancelMsg, { parse_mode: 'HTML' });
    } catch {
      try {
        await ctx.reply(cancelMsg, { parse_mode: 'HTML' });
      } catch {}
    }

    return;
  }

  if (cancelResult && cancelResult.job) {
    const job = cancelResult.job;
    logger.info(`Download #${job.id} cancelled by ${userInfo} (stage: ${cancelResult.stage})`);

    // Delete user's /cancel command message
    try {
      await ctx.deleteMessage();
    } catch {}

    // Edit status message safely to indicate cancellation
    if (job.progressReporter) {
      await job.progressReporter.cancel('❌ Download cancelled.');
      setTimeout(() => {
        ctx.telegram.deleteMessage(chatId, job.statusMessageId).catch(() => {});
      }, 3000);
    } else if (job.statusMessageId) {
      try {
        await ctx.telegram.editMessageText(chatId, job.statusMessageId, null, '❌ Download cancelled.');
        setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, job.statusMessageId).catch(() => {});
        }, 3000);
      } catch {}
    } else {
      try {
        const confirmation = await ctx.reply('❌ Download cancelled.');
        setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, confirmation.message_id).catch(() => {});
        }, 3000);
      } catch {}
    }

    return;
  }

  // 2. Try cancelling pending YouTube quality selection prompt
  if (youtubeStrategy && typeof youtubeStrategy.cancelPending === 'function') {
    const ytResult = youtubeStrategy.cancelPending(chatId, targetMessageId, userId, isChatAdmin);
    if (ytResult && ytResult.unauthorized) {
      return ctx.reply('⚠️ You can only cancel your own requests. Ask a chat admin to cancel it.');
    }
    if (ytResult && ytResult.messageId) {
      try {
        await ctx.telegram.deleteMessage(chatId, ytResult.messageId);
      } catch {}
      try {
        await ctx.deleteMessage();
      } catch {}

      try {
        const confirmation = await ctx.reply('❌ Request cancelled.');
        setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, confirmation.message_id).catch(() => {});
        }, 3000);
      } catch {}
      return;
    }
  }

  // 3. Try cancelling pending Spotify confirmation prompt
  if (spotifyStrategy && typeof spotifyStrategy.cancelPending === 'function') {
    const spotResult = spotifyStrategy.cancelPending(chatId, targetMessageId, userId, isChatAdmin);
    if (spotResult && spotResult.unauthorized) {
      return ctx.reply('⚠️ You can only cancel your own requests. Ask a chat admin to cancel it.');
    }
    if (spotResult && spotResult.messageId) {
      try {
        await ctx.telegram.deleteMessage(chatId, spotResult.messageId);
      } catch {}
      try {
        await ctx.deleteMessage();
      } catch {}

      try {
        const confirmation = await ctx.reply('❌ Request cancelled.');
        setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, confirmation.message_id).catch(() => {});
        }, 3000);
      } catch {}
      return;
    }
  }

  // 4. Try cancelling pending song search prompt
  const searchResult = cancelPendingSearch(chatId, targetMessageId, userId, isChatAdmin);
  if (searchResult && searchResult.unauthorized) {
    return ctx.reply('⚠️ You can only cancel your own requests. Ask a chat admin to cancel it.');
  }
  if (searchResult && searchResult.messageId) {
    try {
      await ctx.telegram.deleteMessage(chatId, searchResult.messageId);
    } catch {}
    try {
      await ctx.deleteMessage();
    } catch {}

    try {
      const confirmation = await ctx.reply('❌ Search cancelled.');
      setTimeout(() => {
        ctx.telegram.deleteMessage(chatId, confirmation.message_id).catch(() => {});
      }, 3000);
    } catch {}
    return;
  }

  // 5. Nothing found to cancel
  return ctx.reply('⚠️ No active downloads to cancel.');
}

module.exports = handleCancel;
