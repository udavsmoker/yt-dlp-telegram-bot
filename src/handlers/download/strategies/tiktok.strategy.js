const BaseStrategy = require('./base.strategy');
const videoService = require('../../../services/video.service');
const queueService = require('../../../services/queue.service');
const logger = require('../../../utils/logger');
const { isTikTokUrl, renderProgressBar } = require('../../../utils/helpers');
const { getSenderInfo, buildCaption, sendMediaToTelegram, cleanupMessages } = require('../common/telegram-sender');
const { tryServeFromCache, cacheSentMedia } = require('../common/cache-helper');

class TikTokStrategy extends BaseStrategy {
  constructor() {
    super('TikTok');
  }

  canHandle(url) {
    return isTikTokUrl(url);
  }

  /**
   * Main entry point for TikTok download processing.
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

      await queueService.enqueue(async () => {
        const progressReporter = queueService.createProgressReporter(ctx, statusMessage.message_id);
        const onProgress = ({ percent, speed, eta }) => {
          progressReporter.update(renderProgressBar(percent, speed, eta));
        };

        try {
          logger.info('Detected TikTok URL, trying TikTok API first (handles both videos and photos)');

          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '⬇️ Downloading from TikTok...'
          );

          let result;
          try {
            result = await videoService.downloadTikTokSlideshow(url, onProgress);
            progressReporter.stop();

            if (result.type === 'video') {
              filePath = result.filePath;
              thumbnailPath = result.thumbnailPath;
              if (filePath) filesToCleanup.push(filePath);
              if (thumbnailPath) filesToCleanup.push(thumbnailPath);

              logger.info('TikTok video downloaded via API');

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
              logger.info(`TikTok video (via API) sent successfully to ${userInfo}`);
              return;
            }

            if (result.type === 'slideshow' || result.type === 'image') {
              if (result.imagePaths) filesToCleanup.push(...result.imagePaths);

              logger.info(`TikTok slideshow downloaded: ${(result.imagePaths || []).length} images`);

              await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMessage.message_id,
                null,
                '📤 Uploading photos to Telegram...'
              );

              const sender = getSenderInfo(ctx);
              const caption = buildCaption(sender, url, result.info);
              const mediaItems = (result.imagePaths || []).map(p => ({ type: 'photo', path: p }));

              await sendMediaToTelegram(ctx, mediaItems, caption);
              await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
              logger.info(`TikTok slideshow sent successfully to ${userInfo}`);
              return;
            }
          } catch (apiError) {
            logger.info(`TikTok API failed, trying yt-dlp fallback: ${apiError.message}`);

            // Cleanup partial files before fallback
            await this.cleanupFiles(filesToCleanup);
            filesToCleanup.length = 0;
            filePath = null;
            thumbnailPath = null;

            try {
              await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMessage.message_id,
                null,
                '⬇️ Trying fallback download method...'
              );

              const fbResult = await videoService.download(url, {}, onProgress);
              progressReporter.stop();

              if (fbResult.type === 'slideshow' || fbResult.type === 'image') {
                if (fbResult.imagePaths) filesToCleanup.push(...fbResult.imagePaths);
                const sender = getSenderInfo(ctx);
                const caption = buildCaption(sender, url, fbResult.info || {});
                const mediaItems = (fbResult.imagePaths || []).map(p => ({ type: 'photo', path: p }));

                await sendMediaToTelegram(ctx, mediaItems, caption);
                await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
                logger.info(`TikTok slideshow (via yt-dlp) sent successfully to ${userInfo}`);
                return;
              }

              filePath = fbResult.filePath;
              thumbnailPath = fbResult.thumbnailPath;
              if (filePath) filesToCleanup.push(filePath);
              if (thumbnailPath) filesToCleanup.push(thumbnailPath);

              logger.info('TikTok video downloaded via yt-dlp fallback');

              await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMessage.message_id,
                null,
                '📤 Uploading to Telegram...'
              );

              const sender = getSenderInfo(ctx);
              const caption = buildCaption(sender, url, fbResult.info);

              const sent = await sendMediaToTelegram(
                ctx,
                [{ type: 'video', path: fbResult.filePath, thumbnailPath: thumbnailPath || undefined }],
                caption,
                { width: fbResult.width, height: fbResult.height, duration: fbResult.duration }
              );
              cacheSentMedia(url, sent, fbResult.info, fbResult);

              await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
              logger.info(`TikTok video (via yt-dlp) sent successfully to ${userInfo}`);
              return;
            } catch (ytdlpError) {
              logger.error('Both TikTok API and yt-dlp failed');
              throw apiError;
            }
          }
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

module.exports = TikTokStrategy;
