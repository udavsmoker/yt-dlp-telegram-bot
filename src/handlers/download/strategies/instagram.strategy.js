const BaseStrategy = require('./base.strategy');
const videoService = require('../../../services/video.service');
const queueService = require('../../../services/queue.service');
const logger = require('../../../utils/logger');
const {
  isInstagramUrl,
  isInstagramPostUrl,
  getInstagramImgIndex,
  getUserInfo,
  renderProgressBar
} = require('../../../utils/helpers');
const { getSenderInfo, buildCaption, sendMediaToTelegram, cleanupMessages } = require('../common/telegram-sender');
const { tryServeFromCache, cacheSentMedia } = require('../common/cache-helper');
const { downloadLimiter } = require('../../../middleware/rate-limit.middleware');

class InstagramStrategy extends BaseStrategy {
  constructor() {
    super('Instagram');
    this.pendingInstagramDownloads = new Map();
  }

  canHandle(url) {
    return isInstagramUrl(url) || isInstagramPostUrl(url);
  }

  /**
   * Main entry point for Instagram URL processing.
   * @param {object} ctx - Telegraf context
   * @param {object} options - { url, userInfo, originalMessageId, statusMessage }
   */
  async handle(ctx, options) {
    const { url, userInfo, originalMessageId } = options;

    // Check if URL has a specific photo index in carousel
    if (isInstagramPostUrl(url)) {
      const imgIndex = getInstagramImgIndex(url);
      if (imgIndex !== null) {
        logger.info(`Instagram carousel link with img_index=${imgIndex} from ${userInfo}: ${url}`);

        const confirmMessage = await ctx.reply(
          `📸 Instagram carousel detected!\n\nPhoto #${imgIndex} was selected. What would you like to download?`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: `📷 Photo #${imgIndex}`, callback_data: 'insta_single' },
                  { text: '📚 Download All', callback_data: 'insta_all' }
                ]
              ]
            }
          }
        );

        this.pendingInstagramDownloads.set(confirmMessage.message_id, {
          userId: ctx.from?.id,
          url,
          imgIndex,
          chatId: ctx.chat.id,
          originalMessageId,
          ctx
        });

        // Auto-download all after 15 seconds if user does not pick
        setTimeout(async () => {
          if (this.pendingInstagramDownloads.has(confirmMessage.message_id)) {
            const pending = this.pendingInstagramDownloads.get(confirmMessage.message_id);
            this.pendingInstagramDownloads.delete(confirmMessage.message_id);

            await ctx.telegram.deleteMessage(pending.chatId, confirmMessage.message_id).catch(() => {});

            logger.info(`Instagram carousel timeout - auto-downloading all for ${userInfo}`);
            const statusMessage = await ctx.telegram.sendMessage(pending.chatId, '⏳ Processing your request...');
            this.processInstagramDownload(pending.ctx, pending.url, statusMessage, userInfo, null, pending.originalMessageId).catch(error => {
              logger.error(`Background Instagram download error for ${userInfo}:`, error);
            });
          }
        }, 15000);

        return;
      }
    }

    // Direct download without carousel prompt
    const statusMessage = options.statusMessage || await ctx.reply('⏳ Processing your request...');
    this.processInstagramDownload(ctx, url, statusMessage, userInfo, null, originalMessageId).catch(error => {
      logger.error(`Background Instagram download error for ${userInfo}:`, error);
    });
  }

  /**
   * Handle carousel choice buttons (insta_single, insta_all).
   * @param {object} ctx
   */
  async handleCallback(ctx) {
    const callbackData = ctx.callbackQuery.data;
    const messageId = ctx.callbackQuery.message.message_id;
    const userId = ctx.from?.id;

    const pendingDownload = this.pendingInstagramDownloads.get(messageId);

    if (!pendingDownload) {
      await ctx.answerCbQuery('⚠️ This request has expired.');
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (pendingDownload.userId && pendingDownload.userId !== userId) {
      await ctx.answerCbQuery('⚠️ Only the person who shared the link can use these buttons.', { show_alert: true });
      return;
    }

    this.pendingInstagramDownloads.delete(messageId);

    await ctx.answerCbQuery('⬇️ Starting download...');
    await ctx.deleteMessage().catch(() => {});

    const userInfo = getUserInfo(ctx);
    const url = pendingDownload.url;
    const imgIndex = callbackData === 'insta_single' ? pendingDownload.imgIndex : null;

    logger.info(`Instagram carousel ${callbackData === 'insta_single' ? `photo #${imgIndex}` : 'all'} download confirmed by ${userInfo}`);

    if (userId) {
      const rateLimit = downloadLimiter.check(String(userId));
      if (rateLimit.limited) {
        await ctx.reply('⏱ Please wait a moment before making another request.');
        return;
      }
    }

    const statusMessage = await ctx.reply('⏳ Processing your request...');
    this.processInstagramDownload(ctx, url, statusMessage, userInfo, imgIndex, pendingDownload.originalMessageId).catch(error => {
      logger.error(`Background Instagram download error for ${userInfo}:`, error);
    });
  }

  /**
   * Orchestrate Instagram download, fallback, sending, and cleanup.
   */
  async processInstagramDownload(ctx, url, statusMessage, userInfo, imgIndex = null, originalMessageId = null) {
    let filePath = null;
    let thumbnailPath = null;
    const filesToCleanup = [];

    try {
      if (await tryServeFromCache(ctx, url, statusMessage.message_id, originalMessageId, userInfo)) {
        return;
      }

      await queueService.enqueue(async ({ signal }) => {
        const progressReporter = queueService.createProgressReporter(ctx, statusMessage.message_id);
        const onProgress = ({ percent, speed, eta }) => {
          progressReporter.update(renderProgressBar(percent, speed, eta));
        };

        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '⬇️ Downloading Instagram post...'
          );

          const result = await videoService.downloadInstagramPost(url, imgIndex, { signal }, onProgress);
          progressReporter.stop();

          // Fallback to yt-dlp if service indicates direct download did not yield media
          if (result.type === 'video' && result.shouldFallback) {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              null,
              '⬇️ Downloading video...\nThis may take a moment for large videos.'
            );

            const videoResult = await videoService.download(url, { signal }, onProgress);
            progressReporter.stop();
            filePath = videoResult.filePath;
            thumbnailPath = videoResult.thumbnailPath;

            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              null,
              '📤 Uploading to Telegram...'
            );

            const sender = getSenderInfo(ctx);
            const caption = buildCaption(sender, url, videoResult.info);

            const sent = await sendMediaToTelegram(
              ctx,
              [{ type: 'video', path: filePath, thumbnailPath: thumbnailPath || undefined }],
              caption,
              { width: videoResult.width, height: videoResult.height, duration: videoResult.duration }
            );
            cacheSentMedia(url, sent, videoResult.info, videoResult);

            await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
            logger.info(`Instagram video sent successfully to ${userInfo}`);
            return;
          }

          if (result.imagePaths) filesToCleanup.push(...result.imagePaths);
          if (result.videoPaths) filesToCleanup.push(...result.videoPaths);

          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );

          const sender = getSenderInfo(ctx);
          const allMedia = [];

          if (result.imagePaths) {
            for (const p of result.imagePaths) {
              allMedia.push({ type: 'photo', path: p });
            }
          }
          if (result.videoPaths) {
            for (const p of result.videoPaths) {
              allMedia.push({ type: 'video', path: p });
            }
          }

          if (result.media && result.media.length > 0) {
            allMedia.length = 0;
            for (const m of result.media) {
              allMedia.push({ type: m.type, path: m.path, thumbnailPath: m.thumbnailPath });
              if (m.thumbnailPath) filesToCleanup.push(m.thumbnailPath);
            }
          }

          const caption = buildCaption(sender, url, result.info);
          const sent = await sendMediaToTelegram(ctx, allMedia, caption, {
            width: result.width,
            height: result.height,
            duration: result.duration
          });
          cacheSentMedia(url, sent, result.info, result);

          await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
          logger.info(`Instagram post sent successfully to ${userInfo}`);
        } finally {
          progressReporter.stop();
        }
      }, { ctx, statusMessageId: statusMessage.message_id });
    } catch (error) {
      await this.sendErrorMessage(ctx, statusMessage.message_id, error, userInfo, true);
    } finally {
      if (filePath) filesToCleanup.push(filePath);
      if (thumbnailPath) filesToCleanup.push(thumbnailPath);
      await this.cleanupFiles(filesToCleanup);
    }
  }
}

module.exports = InstagramStrategy;
