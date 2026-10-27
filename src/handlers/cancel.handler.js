const queueService = require('../services/queue.service');
const { youtubeStrategy } = require('./download');
const { isAdmin, getUserInfo } = require('../utils/helpers');
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

  // 1. Try cancelling active or queued download job in QueueService
  const cancelResult = queueService.cancelJob(chatId, targetMessageId, userId, isChatAdmin);

  if (cancelResult && cancelResult.unauthorized) {
    return ctx.reply('⚠️ You can only cancel your own downloads. Ask a chat admin to cancel it.');
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

  // 3. Nothing found to cancel
  return ctx.reply('⚠️ No active downloads to cancel.');
}

module.exports = handleCancel;
