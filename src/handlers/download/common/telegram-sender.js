const { getFileForTelegram } = require('../../../utils/helpers');
const logger = require('../../../utils/logger');

/**
 * Extract sender name and HTML mention link for user or channel.
 * @param {object} ctx - Telegraf context
 * @returns {{ name: string, caption: string }}
 */
function getSenderInfo(ctx) {
  const senderChat = ctx.senderChat || ctx.message?.sender_chat;
  if (senderChat) {
    const title = senderChat.title || 'Channel';
    return { name: title, caption: title };
  }
  if (ctx.chat?.type === 'channel') {
    const title = ctx.chat?.title || 'Channel';
    return { name: title, caption: title };
  }
  if (ctx.from) {
    const fullName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
    const userMention = ctx.from.username ? `@${ctx.from.username}` : fullName;
    return {
      name: fullName,
      caption: `<a href="tg://user?id=${ctx.from.id}">${userMention}</a>`
    };
  }
  const title = ctx.chat?.title || 'Channel';
  return { name: title, caption: title };
}

/**
 * Truncate long media titles to comply with Telegram caption limits.
 * @param {string} title
 * @param {number} maxLen
 * @returns {string|null}
 */
function truncateTitle(title, maxLen = 200) {
  if (!title) return null;
  if (title.length <= maxLen) return title;
  return title.substring(0, maxLen) + '…';
}

/**
 * Build HTML caption with expandable blockquote for media items.
 * @param {object} sender - Result from getSenderInfo()
 * @param {string} url - Source URL
 * @param {object} info - Media metadata
 * @returns {string}
 */
function buildCaption(sender, url, info = {}) {
  const metaLines = [
    info.title && info.title !== 'Video' && info.title !== 'Bluesky Video' && info.title !== 'Bluesky Post'
      ? `${truncateTitle(info.title)}\n` : null,
    `👤 ${info.author || 'Unknown'}`,
    info.duration && info.duration !== 'Unknown' ? `⏱ ${info.duration}` : null,
    info.fileSize && info.fileSize !== 'Unknown' ? `💾 ${info.fileSize}` : null,
    `📱 ${info.platform || 'Unknown'}`,
    info.quality ? `📊 ${info.quality}` : null
  ].filter(Boolean).join('\n');

  return `${sender.caption} shared: <a href="${url}">Link</a>\n\n<blockquote expandable>${metaLines}</blockquote>`.trim();
}

/**
 * Send media items (photos and videos) to Telegram in batches of up to 10 items.
 * @param {object} ctx - Telegraf context
 * @param {Array<{type: 'photo'|'video', path: string, thumbnailPath?: string}>} mediaItems
 * @param {string} caption - HTML caption for the last batch
 * @param {object} videoMeta - { width, height, duration } for video items
 * @returns {Promise<Array>} Sent Telegram message objects
 */
async function sendMediaToTelegram(ctx, mediaItems, caption, videoMeta = {}) {
  const TELEGRAM_MEDIA_LIMIT = 10;
  const batches = [];
  for (let i = 0; i < mediaItems.length; i += TELEGRAM_MEDIA_LIMIT) {
    batches.push(mediaItems.slice(i, i + TELEGRAM_MEDIA_LIMIT));
  }

  const sentMessages = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const isLastBatch = batchIndex === batches.length - 1;

    if (batch.length === 1 && batches.length === 1) {
      const item = batch[0];
      if (item.type === 'photo') {
        const sent = await ctx.replyWithPhoto(getFileForTelegram(item.path), { caption, parse_mode: 'HTML' });
        sentMessages.push(sent);
      } else {
        const opts = {
          caption,
          parse_mode: 'HTML',
          supports_streaming: true,
          width: videoMeta.width,
          height: videoMeta.height,
          duration: videoMeta.duration
        };
        if (item.thumbnailPath) opts.thumbnail = getFileForTelegram(item.thumbnailPath);
        const sent = await ctx.replyWithVideo(getFileForTelegram(item.path), opts);
        sentMessages.push(sent);
      }
    } else {
      const mediaGroup = batch.map((item, index) => ({
        type: item.type,
        media: getFileForTelegram(item.path),
        caption: isLastBatch && index === 0 ? caption : undefined,
        parse_mode: isLastBatch && index === 0 ? 'HTML' : undefined,
        thumbnail: item.thumbnailPath ? getFileForTelegram(item.thumbnailPath) : undefined,
        ...(item.type === 'video' ? {
          supports_streaming: true,
          width: videoMeta.width,
          height: videoMeta.height,
          duration: videoMeta.duration
        } : {})
      }));

      try {
        const sent = await ctx.replyWithMediaGroup(mediaGroup);
        if (Array.isArray(sent)) sentMessages.push(...sent);
      } catch (sendError) {
        if (sendError.message?.includes('caption is too long') || sendError.description?.includes('caption is too long')) {
          logger.warn(`Caption too long for batch ${batchIndex + 1}, retrying without caption`);
          const fallbackGroup = batch.map(item => ({
            type: item.type,
            media: getFileForTelegram(item.path)
          }));
          const sent = await ctx.replyWithMediaGroup(fallbackGroup);
          if (Array.isArray(sent)) sentMessages.push(...sent);
        } else {
          throw sendError;
        }
      }
    }
    logger.info(`Sent batch ${batchIndex + 1}/${batches.length} (${batch.length} item(s))`);
  }

  if (sentMessages.length > 0 && ctx.chat?.id) {
    const undoService = require('../../../services/undo.service');
    undoService.record(ctx.chat.id, sentMessages.map(m => m.message_id), ctx.from?.id);
  }

  return sentMessages;
}

/**
 * Delete status and/or original trigger messages with error suppression.
 * @param {object} ctx - Telegraf context
 * @param {number} statusMessageId
 * @param {number} originalMessageId
 */
async function cleanupMessages(ctx, statusMessageId, originalMessageId) {
  try {
    if (originalMessageId) {
      await ctx.telegram.deleteMessage(ctx.chat.id, originalMessageId);
    }
  } catch {
    logger.warn('Could not delete user message (bot might lack delete permissions)');
  }
  if (statusMessageId) {
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
  }
}

module.exports = {
  getSenderInfo,
  truncateTitle,
  buildCaption,
  sendMediaToTelegram,
  cleanupMessages
};
