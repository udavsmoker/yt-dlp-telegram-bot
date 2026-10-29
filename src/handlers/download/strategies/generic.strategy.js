const BaseStrategy = require('./base.strategy');
const videoService = require('../../../services/video.service');
const queueService = require('../../../services/queue.service');
const logger = require('../../../utils/logger');
const { renderProgressBar } = require('../../../utils/helpers');
const { getSenderInfo, buildCaption, sendMediaToTelegram, cleanupMessages } = require('../common/telegram-sender');
const { tryServeFromCache, cacheSentMedia } = require('../common/cache-helper');

class GenericStrategy extends BaseStrategy {
  constructor() {
    super('Generic');
  }

  canHandle(_url) {
    // Catch-all strategy for any valid video URL supported by yt-dlp
    return true;
  }

  /**
   * Main entry point for generic yt-dlp download processing.
   * @param {object} ctx - Telegraf context
   * @param {object} options - { url, userInfo, originalMessageId, statusMessage }
   */
  async handle(ctx, options) {
    const { url, userInfo, originalMessageId } = options;
    const statusMessage = options.statusMessage || await ctx.reply('⏳ Processing your request...');

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
            '⬇️ Downloading video...\nThis may take a moment for large videos.'
          );

          const result = await videoService.download(url, { signal }, onProgress);
          progressReporter.stop();

          // Handle image/slideshow responses from generic extractors
          if (result.type === 'slideshow' || result.type === 'image') {
            const sender = getSenderInfo(ctx);
            if (result.imagePaths) filesToCleanup.push(...result.imagePaths);

            logger.info(`Slideshow/Images downloaded: ${(result.imagePaths || []).length} images`);

            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              null,
              '📤 Uploading photos to Telegram...'
            );

            if (result.imagePaths && result.imagePaths.length > 0) {
              const caption = buildCaption(sender, url, result.info || {});
              const mediaItems = result.imagePaths.map(p => ({ type: 'photo', path: p }));
              await sendMediaToTelegram(ctx, mediaItems, caption);
            }

            await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
            return;
          }

          filePath = result.filePath;
          thumbnailPath = result.thumbnailPath;
          if (filePath) filesToCleanup.push(filePath);
          if (thumbnailPath) filesToCleanup.push(thumbnailPath);

          logger.info(`Video downloaded, platform: ${result.info?.platform || 'unknown'}`);

          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );

          const sender = getSenderInfo(ctx);
          const caption = buildCaption(sender, url, result.info);

          const sent = await sendMediaToTelegram(
            ctx,
            [{ type: 'video', path: result.filePath, thumbnailPath: thumbnailPath || undefined }],
            caption,
            { width: result.width, height: result.height, duration: result.duration }
          );
          cacheSentMedia(url, sent, result.info, result);

          await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
          logger.info(`Video sent successfully to ${userInfo}`);
        } finally {
          progressReporter.stop();
        }
      }, { ctx, statusMessageId: statusMessage.message_id });
    } catch (error) {
      await this.sendErrorMessage(ctx, statusMessage.message_id, error, userInfo, false);
    } finally {
      await this.cleanupFiles(filesToCleanup);
    }
  }
}

module.exports = GenericStrategy;
