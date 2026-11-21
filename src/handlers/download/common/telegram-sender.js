const { getFileForTelegram, escapeHtml, sanitizePhotoForTelegram } = require('../../../utils/helpers');
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
  const isDummyTitle = !info.title ||
    info.title === 'Video' ||
    info.title === 'Bluesky Video' ||
    info.title === 'Bluesky Post' ||
    info.title === 'Twitter Video' ||
    info.title === 'Twitter Post' ||
    /^[a-zA-Z0-9_-]{12,25}$/.test(info.title);

  const titleLine = !isDummyTitle
    ? `${escapeHtml(truncateTitle(info.title))}\n`
    : null;

  const authorLine = `👤 ${escapeHtml(info.author || 'Unknown')}`;

  const metaLines = [
    titleLine,
    authorLine,
    info.duration && info.duration !== 'Unknown' ? `⏱ ${info.duration}` : null,
    info.fileSize && info.fileSize !== 'Unknown' ? `💾 ${info.fileSize}` : null,
    `📱 ${escapeHtml(info.platform || 'Unknown')}`,
    info.quality ? `📊 ${escapeHtml(info.quality)}` : null
  ].filter(Boolean).join('\n');

  return `${sender.caption} shared: <a href="${url}">Link</a>\n\n<blockquote expandable>${metaLines}</blockquote>`.trim();
}

/**
 * Partition media items into balanced batches of at most 10 items.
 * Guarantees every batch has 2-10 items when total > 1, avoiding single-item albums.
 * @param {Array} mediaItems
 * @returns {Array<Array>}
 */
function partitionMediaItems(mediaItems) {
  const n = mediaItems.length;
  if (n <= 10) return [mediaItems];
  const numBatches = Math.ceil(n / 10);
  const batches = [];
  let startIndex = 0;
  for (let i = 0; i < numBatches; i++) {
    const batchSize = Math.floor(n / numBatches) + (i < (n % numBatches) ? 1 : 0);
    batches.push(mediaItems.slice(startIndex, startIndex + batchSize));
    startIndex += batchSize;
  }
  return batches;
}

function getTelegramErrorText(error) {
  return error.description ||
    error.response?.data?.description ||
    error.response?.description ||
    error.message ||
    '';
}

function isNetworkError(error, text) {
  return text.includes('socket hang up') ||
    text.includes('ECONNRESET') ||
    text.includes('ETIMEDOUT') ||
    text.includes('ECONNREFUSED') ||
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildMediaGroup(items, caption, putCaption, videoMeta) {
  return items.map((item, index) => ({
    type: item.type,
    media: getFileForTelegram(item.path),
    caption: putCaption && index === 0 ? caption : undefined,
    parse_mode: putCaption && index === 0 ? 'HTML' : undefined,
    thumbnail: item.thumbnailPath ? getFileForTelegram(item.thumbnailPath) : undefined,
    ...(item.type === 'video' ? {
      supports_streaming: true,
      width: videoMeta.width,
      height: videoMeta.height,
      duration: videoMeta.duration
    } : {})
  }));
}

async function sendMediaGroup(ctx, items, caption, putCaption, videoMeta) {
  let currentItems = [...items];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await ctx.replyWithMediaGroup(
        buildMediaGroup(currentItems, caption, putCaption, videoMeta)
      );
    } catch (error) {
      const text = getTelegramErrorText(error);

      if (text.includes('caption is too long')) {
        logger.warn('Caption too long for media batch, retrying without caption');
        return ctx.replyWithMediaGroup(
          buildMediaGroup(currentItems, undefined, false, videoMeta)
        );
      }

      if (/IMAGE_PROCESS_FAILED|IMAGE PROCESS FAILED/i.test(text) && currentItems.length > 1) {
        const match = text.match(/failed to send message\s*#?(\d+)/i);
        const failedIndex = match
          ? Math.max(0, Math.min(currentItems.length - 1, parseInt(match[1], 10) - 1))
          : currentItems.length - 1;
        logger.warn(`Telegram could not process photo #${failedIndex + 1}, excluding it from the album`);
        currentItems.splice(failedIndex, 1);
        continue;
      }

      if (isNetworkError(error, text) && attempt < 2) {
        logger.warn(`Local Telegram Bot API connection dropped (attempt ${attempt + 1}/3), retrying`);
        await delay(250 * (attempt + 1));
        continue;
      }

      throw error;
    }
  }

  if (currentItems.length === 1 && currentItems[0].type === 'photo') {
    return ctx.replyWithPhoto(getFileForTelegram(currentItems[0].path), {
      caption: putCaption ? caption : undefined,
      parse_mode: putCaption ? 'HTML' : undefined
    });
  }

  throw new Error('MEDIA_GROUP_SEND_FAILED');
}

async function sendMediaGroupRecoverably(ctx, items, caption, putCaption, videoMeta) {
  if (items.length <= 1) return null;

  try {
    return await sendMediaGroup(ctx, items, caption, putCaption, videoMeta);
  } catch (error) {
    const text = getTelegramErrorText(error);
    if (!isNetworkError(error, text) || items.length <= 2) {
      throw error;
    }

    const splitIndex = Math.ceil(items.length / 2);
    const firstPart = items.slice(0, splitIndex);
    const secondPart = items.slice(splitIndex);
    logger.warn(`Splitting ${items.length}-item album after repeated network errors`);

    const sent = [];
    const first = await sendMediaGroup(ctx, firstPart, caption, false, videoMeta);
    if (Array.isArray(first)) sent.push(...first);
    const second = await sendMediaGroup(ctx, secondPart, caption, putCaption, videoMeta);
    if (Array.isArray(second)) sent.push(...second);
    return sent;
  }
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
  const batches = partitionMediaItems(mediaItems);
  const sentMessages = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const isLastBatch = batchIndex === batches.length - 1;

    if (batch.length === 1) {
      const item = batch[0];
      const singleCaption = isLastBatch ? caption : undefined;
      if (item.type === 'photo') {
        try { await sanitizePhotoForTelegram(item.path); } catch {}
        let sent;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            sent = await ctx.replyWithPhoto(getFileForTelegram(item.path), {
              caption: singleCaption,
              parse_mode: singleCaption ? 'HTML' : undefined
            });
            break;
          } catch (error) {
            const text = getTelegramErrorText(error);
            if (!isNetworkError(error, text) || attempt === 2) throw error;
            await delay(250 * (attempt + 1));
          }
        }
        sentMessages.push(sent);
      } else {
        const opts = {
          caption: singleCaption,
          parse_mode: singleCaption ? 'HTML' : undefined,
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
      for (const item of batch) {
        if (item.type === 'photo') {
          try { await sanitizePhotoForTelegram(item.path); } catch {}
        }
      }

      const sent = await sendMediaGroupRecoverably(
        ctx,
        batch,
        caption,
        isLastBatch,
        videoMeta
      );
      if (Array.isArray(sent)) sentMessages.push(...sent);
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
  partitionMediaItems,
  sendMediaToTelegram,
  cleanupMessages
};
