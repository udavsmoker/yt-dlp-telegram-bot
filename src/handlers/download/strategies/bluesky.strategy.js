const BaseStrategy = require('./base.strategy');
const videoService = require('../../../services/video.service');
const queueService = require('../../../services/queue.service');
const logger = require('../../../utils/logger');
const { isBlueskyUrl, isBlueskyPostUrl, renderProgressBar } = require('../../../utils/helpers');
const { getSenderInfo, buildCaption, sendMediaToTelegram, cleanupMessages } = require('../common/telegram-sender');
const { tryServeFromCache, cacheSentMedia } = require('../common/cache-helper');

class BlueskyStrategy extends BaseStrategy {
  constructor() {
    super('Bluesky');
  }

  canHandle(url) {
    return isBlueskyUrl(url) || isBlueskyPostUrl(url);
  }

  /**
   * Main entry point for Bluesky download processing.
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
          logger.info('Detected Bluesky URL, trying AT Protocol API first');

          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '⬇️ Downloading from Bluesky...'
          );

          let result;
          try {
            result = await videoService.downloadBlueskyPost(url, onProgress);
            progressReporter.stop();

            if (result.type === 'video') {
              filePath = result.filePath;
              thumbnailPath = result.thumbnailPath;
              if (filePath) filesToCleanup.push(filePath);
              if (thumbnailPath) filesToCleanup.push(thumbnailPath);

              logger.info('Bluesky video downloaded via API');

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
              logger.info(`Bluesky video sent successfully to ${userInfo}`);
              return;
            }

            if (result.type === 'slideshow') {
              if (result.imagePaths) filesToCleanup.push(...result.imagePaths);

              logger.info(`Bluesky images downloaded: ${result.imagePaths.length} image(s)`);

              await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMessage.message_id,
                null,
                '📤 Uploading photos to Telegram...'
              );

              const sender = getSenderInfo(ctx);
              const caption = buildCaption(sender, url, result.info);
              const mediaItems = result.imagePaths.map(img => ({ type: 'photo', path: img }));

              await sendMediaToTelegram(ctx, mediaItems, caption);
              await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
              logger.info(`Bluesky images sent successfully to ${userInfo}`);
              return;
            }
          } catch (apiError) {
            logger.info(`Bluesky API failed, trying yt-dlp fallback: ${apiError.message}`);

            await this.cleanupFiles(filesToCleanup);
            filesToCleanup.length = 0;
            filePath = null;
            thumbnailPath = null;

            if (apiError.message.includes('only text') || apiError.message.includes('link card')) {
              throw apiError;
            }

            try {
              await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMessage.message_id,
                null,
                '⬇️ Trying fallback download method...'
              );

              const fbResult = await videoService.download(url, {}, onProgress);
              progressReporter.stop();

              filePath = fbResult.filePath;
              thumbnailPath = fbResult.thumbnailPath;
              if (filePath) filesToCleanup.push(filePath);
              if (thumbnailPath) filesToCleanup.push(thumbnailPath);

              logger.info('Bluesky video downloaded via yt-dlp fallback');

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
              logger.info(`Bluesky video (via yt-dlp) sent successfully to ${userInfo}`);
              return;
            } catch (ytdlpError) {
              logger.error('Both Bluesky API and yt-dlp failed');
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

module.exports = BlueskyStrategy;
