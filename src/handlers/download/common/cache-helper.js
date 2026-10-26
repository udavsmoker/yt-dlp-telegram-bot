const cacheService = require('../../../services/cache.service');
const logger = require('../../../utils/logger');
const { getSenderInfo, buildCaption, cleanupMessages } = require('./telegram-sender');

/**
 * Attempt to fulfill a download request from cache using Telegram file_id.
 * @param {object} ctx - Telegraf context
 * @param {string} url - Target URL
 * @param {number} statusMessageId - ID of the processing message to delete on success
 * @param {number} originalMessageId - User's trigger message ID to delete on success
 * @param {string} userInfo - Human-readable user info for logging
 * @param {string|null} requiredType - Optional required media type ('video', 'audio', 'photo')
 * @param {Function|null} onYouTubeAudioReady - Callback(sentMsg, cached) when YouTube video is served from cache
 * @returns {Promise<boolean>} True if fulfilled from cache, false otherwise
 */
async function tryServeFromCache(ctx, url, statusMessageId, originalMessageId, userInfo, requiredType = null, onYouTubeAudioReady = null) {
  const cached = cacheService.get(url);
  if (!cached) return false;
  if (requiredType && cached.file_type !== requiredType) return false;

  logger.info(`Cache hit for ${url} (hits: ${cached.hit_count})`);
  const sender = getSenderInfo(ctx);
  const caption = buildCaption(sender, url, {
    author: cached.author,
    duration: cached.duration,
    fileSize: cached.file_size ? `${(cached.file_size / (1024 * 1024)).toFixed(1)}MB` : null,
    platform: cached.platform,
    quality: cached.quality,
    title: cached.title
  });

  try {
    let sentMsg = null;
    if (cached.file_type === 'photo') {
      sentMsg = await ctx.replyWithPhoto(cached.file_id, { caption, parse_mode: 'HTML' });
    } else if (cached.file_type === 'audio') {
      sentMsg = await ctx.replyWithAudio(cached.file_id, {
        title: cached.title || undefined,
        performer: cached.author || undefined,
        duration: cached.duration ? parseInt(cached.duration, 10) : undefined
      });
    } else if (cached.file_type === 'video') {
      const videoOptions = {
        caption,
        parse_mode: 'HTML',
        supports_streaming: true,
        width: cached.width || undefined,
        height: cached.height || undefined,
        duration: cached.duration || undefined
      };
      if (cached.platform === 'YouTube') {
        videoOptions.reply_markup = {
          inline_keyboard: [[{ text: '🎵 Audio', callback_data: 'yt_audio' }]]
        };
      }
      sentMsg = await ctx.replyWithVideo(cached.file_id, videoOptions);

      if (sentMsg?.video?.file_id && cached.platform === 'YouTube' && typeof onYouTubeAudioReady === 'function') {
        onYouTubeAudioReady(sentMsg, cached);
      }
    }

    if (sentMsg) {
      await cleanupMessages(ctx, statusMessageId, originalMessageId);
      logger.info(`Served ${url} from cache to ${userInfo}`);
      return true;
    }
  } catch (error) {
    logger.warn(`Failed to serve from cache for ${url}, invalidating: ${error.message}`);
    cacheService.delete(url);
  }

  return false;
}

/**
 * Cache single sent media item by its Telegram file_id.
 * @param {string} url - Source URL
 * @param {Array} sentMessages - Array of sent Telegram messages
 * @param {object} info - Media metadata
 * @param {object} meta - Additional info (e.g. width, height, duration)
 */
function cacheSentMedia(url, sentMessages, info = {}, meta = {}) {
  try {
    if (!sentMessages || sentMessages.length === 0) return;
    if (sentMessages.length === 1) {
      const msg = sentMessages[0];
      let fileId = null;
      let fileType = 'video';

      if (msg.video) {
        fileId = msg.video.file_id;
        fileType = 'video';
      } else if (msg.photo && msg.photo.length > 0) {
        fileId = msg.photo[msg.photo.length - 1].file_id;
        fileType = 'photo';
      }

      if (fileId) {
        cacheService.set(url, {
          fileId,
          fileType,
          fileSize: meta.fileSize || info.fileSize,
          platform: info.platform,
          title: info.title,
          author: info.author,
          duration: info.duration,
          quality: info.quality,
          width: meta.width || (msg.video ? msg.video.width : undefined),
          height: meta.height || (msg.video ? msg.video.height : undefined),
          captionInfo: info
        });
      }
    }
  } catch (error) {
    logger.warn(`Failed to cache sent media for ${url}: ${error.message}`);
  }
}

module.exports = {
  tryServeFromCache,
  cacheSentMedia
};
