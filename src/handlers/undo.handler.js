const undoService = require('../services/undo.service');
const { isAdmin, getUserInfo } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Handle /undo command: delete bot's sent media either by replying to it or by popping last sent.
 * @param {object} ctx - Telegraf context
 */
async function handleUndo(ctx) {
  const userInfo = getUserInfo(ctx);
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const replyMessage = ctx.message?.reply_to_message;
  const isChatAdmin = await isAdmin(ctx);
  const userId = ctx.from?.id;

  let messageIdsToDelete = [];

  if (replyMessage) {
    // User replied to a specific message
    const isBotMessage = replyMessage.from?.id === ctx.botInfo?.id;
    if (!isBotMessage) {
      return ctx.reply('⚠️ Reply to a message sent by the bot to delete it.');
    }

    const result = undoService.findAndRemove(chatId, replyMessage.message_id, userId, isChatAdmin);

    if (result && result.unauthorized) {
      return ctx.reply('⚠️ You can only delete media you requested. Ask a chat admin to delete it.');
    }

    if (result && result.messageIds) {
      messageIdsToDelete = result.messageIds;
    } else {
      // Not tracked in memory (e.g. sent before restart)
      const isPrivateChat = ctx.chat.type === 'private';
      const isMentionedInCaption = replyMessage.caption && userId && replyMessage.caption.includes(`tg://user?id=${userId}`);

      if (isChatAdmin || isPrivateChat || isMentionedInCaption) {
        messageIdsToDelete = [replyMessage.message_id];
      } else {
        return ctx.reply('⚠️ Cannot verify that you requested this media. Only chat admins can delete it.');
      }
    }
  } else {
    // User called /undo without reply: pop latest for user (or latest in chat if admin)
    const result = undoService.findAndRemove(chatId, null, userId, isChatAdmin);

    if (!result || !result.messageIds || result.messageIds.length === 0) {
      return ctx.reply('⚠️ No recent media to undo.');
    }

    messageIdsToDelete = result.messageIds;
  }

  // Execute deletion
  let deletedCount = 0;
  for (const msgId of messageIdsToDelete) {
    try {
      await ctx.telegram.deleteMessage(chatId, msgId);
      deletedCount++;
    } catch (err) {
      logger.warn(`Could not delete message ${msgId} in chat ${chatId}: ${err.message}`);
    }
  }

  // Delete the /undo trigger message itself
  try {
    await ctx.deleteMessage();
  } catch {}

  logger.info(`Undo executed by ${userInfo} in chat ${chatId} (${deletedCount} message(s) deleted)`);

  // Send temporary auto-expiring confirmation
  try {
    const confirmation = await ctx.reply('🗑 Media deleted.');
    setTimeout(() => {
      ctx.telegram.deleteMessage(chatId, confirmation.message_id).catch(() => {});
    }, 3000);
  } catch {}
}

module.exports = handleUndo;
