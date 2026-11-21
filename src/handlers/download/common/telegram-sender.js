const { getFileForTelegram, escapeHtml } = require('../../../utils/helpers');
const logger = require('../../../utils/logger');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const fs = require('fs').promises;

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
        const sent = await ctx.replyWithPhoto(getFileForTelegram(item.path), {
          caption: singleCaption,
          parse_mode: singleCaption ? 'HTML' : undefined
        });
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
      let currentBatch = [...batch];
      const sendGroup = async (items) => {
        const mediaGroup = items.map((item, index) => ({
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
        return ctx.replyWithMediaGroup(mediaGroup);
      };

      try {
        const sent = await sendGroup(currentBatch);
        if (Array.isArray(sent)) sentMessages.push(...sent);
      } catch (sendError) {
        if (sendError.message?.includes('caption is too long') || sendError.description?.includes('caption is too long')) {
          logger.warn(`Caption too long for batch ${batchIndex + 1}, retrying without caption`);
          const fallbackGroup = currentBatch.map(item => ({
            type: item.type,
            media: getFileForTelegram(item.path)
          }));
          const sent = await ctx.replyWithMediaGroup(fallbackGroup);
          if (Array.isArray(sent)) sentMessages.push(...sent);
        } else if (sendError.message?.includes('IMAGE_PROCESS_FAILED') || sendError.description?.includes('IMAGE_PROCESS_FAILED')) {
          logger.warn(`IMAGE_PROCESS_FAILED in batch ${batchIndex + 1}, re-encoding photos with ffmpeg to standard baseline JPEG...`);
          for (const item of currentBatch) {
            if (item.type === 'photo') {
              const cleanPath = item.path + '.clean.jpg';
              try {
                await execFile('ffmpeg', ['-y', '-i', item.path, '-vf', 'format=yuv420p', '-frames:v', '1', '-q:v', '2', cleanPath], { timeout: 10000 });
                await fs.unlink(item.path);
                await fs.rename(cleanPath, item.path);
              } catch {
                try { await fs.unlink(cleanPath); } catch {}
              }
            }
          }
          try {
            const sent = await sendGroup(currentBatch);
            if (Array.isArray(sent)) sentMessages.push(...sent);
          } catch (retryErr) {
            logger.warn(`MediaGroup retry failed after re-encoding (${retryErr.message}), recovering album`);
            const errText = retryErr.description || retryErr.message || '';
            const match = errText.match(/failed to send message #(\d+)/i);
            if (match && currentBatch.length > 2) {
              const failedIdx = parseInt(match[1], 10) - 1;
              logger.warn(`Excluding problematic photo #${failedIdx + 1} from album and retrying media group`);
              currentBatch.splice(failedIdx, 1);
              try {
                const sent = await sendGroup(currentBatch);
                if (Array.isArray(sent)) sentMessages.push(...sent);
              } catch (finalGroupErr) {
                logger.error(`Media group recovery failed: ${finalGroupErr.message}`);
                throw finalGroupErr;
              }
            } else {
              throw retryErr;
            }
          }
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
  partitionMediaItems,
  sendMediaToTelegram,
  cleanupMessages
};
