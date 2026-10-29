const BaseStrategy = require('./base.strategy');
const videoService = require('../../../services/video.service');
const audioService = require('../../../services/audio.service');
const queueService = require('../../../services/queue.service');
const logger = require('../../../utils/logger');
const { isYouTubeUrl, getUserInfo, cleanupFile, getFileForTelegram, renderProgressBar } = require('../../../utils/helpers');
const { getSenderInfo, buildCaption, sendMediaToTelegram, cleanupMessages } = require('../common/telegram-sender');
const { tryServeFromCache, cacheSentMedia } = require('../common/cache-helper');
const { registerPendingAudioExtract } = require('../audio/audio-extractor');
const { downloadLimiter } = require('../../../middleware/rate-limit.middleware');

class YouTubeStrategy extends BaseStrategy {
  constructor() {
    super('YouTube');
    this.pendingYouTubeDownloads = new Map();
  }

  canHandle(url) {
    return isYouTubeUrl(url);
  }

  /**
   * Display quality selection keyboard for detected YouTube link.
   * @param {object} ctx
   * @param {object} options - { url, userInfo, originalMessageId }
   */
  async handle(ctx, options) {
    const { url, userInfo, originalMessageId } = options;
    logger.info(`YouTube link detected from ${userInfo}: ${url}`);

    const confirmMessage = await ctx.reply(
      '🎬 YouTube link detected!\n\nSelect download quality:',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🎬 1080p (Best)', callback_data: 'ytq_1080' },
              { text: '🎬 720p (HD)', callback_data: 'ytq_720' }
            ],
            [
              { text: '🎬 480p (SD)', callback_data: 'ytq_480' },
              { text: '🎵 Audio Only', callback_data: 'ytq_audio' }
            ],
            [
              { text: '❌ Just Sharing', callback_data: 'ytq_cancel' }
            ]
          ]
        }
      }
    );

    this.pendingYouTubeDownloads.set(confirmMessage.message_id, {
      userId: ctx.from?.id,
      url,
      originalMessageId,
      chatId: ctx.chat.id
    });

    setTimeout(() => {
      if (this.pendingYouTubeDownloads.has(confirmMessage.message_id)) {
        this.pendingYouTubeDownloads.delete(confirmMessage.message_id);
        ctx.telegram.deleteMessage(ctx.chat.id, confirmMessage.message_id).catch(() => {});
      }
    }, 60000);
  }

  /**
   * Cancel pending YouTube quality selection prompt.
   * @param {string|number} chatId
   * @param {number|null} targetMessageId
   * @param {number|null} userId
   * @param {boolean} isChatAdmin
   * @returns {{ messageId: number, pending: object } | { unauthorized: true } | null}
   */
  cancelPending(chatId, targetMessageId = null, userId = null, isChatAdmin = false) {
    const keyChatId = Number(chatId);
    const parsedTargetId = targetMessageId ? Number(targetMessageId) : null;
    const parsedUserId = userId ? Number(userId) : null;

    for (const [msgId, pending] of Array.from(this.pendingYouTubeDownloads.entries()).reverse()) {
      if (pending.chatId && Number(pending.chatId) !== keyChatId) continue;
      if (parsedTargetId && msgId !== parsedTargetId) continue;

      const isOwner = parsedUserId && pending.userId === parsedUserId;
      if (!isChatAdmin && !isOwner && pending.userId) {
        return { unauthorized: true };
      }

      this.pendingYouTubeDownloads.delete(msgId);
      return { messageId: msgId, pending };
    }
    return null;
  }

  /**
   * Handle user click on quality selection or cancel buttons.
   * @param {object} ctx
   */
  async handleCallback(ctx) {
    const callbackData = ctx.callbackQuery.data;
    const messageId = ctx.callbackQuery.message.message_id;
    const userId = ctx.from?.id;

    const pending = this.pendingYouTubeDownloads.get(messageId);

    if (!pending) {
      await ctx.answerCbQuery('⚠️ This request has expired.');
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (pending.userId && pending.userId !== userId) {
      await ctx.answerCbQuery('⚠️ Only the person who shared the link can use these buttons.', { show_alert: true });
      return;
    }

    this.pendingYouTubeDownloads.delete(messageId);

    if (callbackData === 'yt_cancel' || callbackData === 'ytq_cancel') {
      await ctx.answerCbQuery('👍 Link shared without download');
      await ctx.deleteMessage().catch(() => {});
      logger.info(`YouTube download cancelled by user ${userId}`);
      return;
    }

    if (userId) {
      const rateLimit = downloadLimiter.check(String(userId));
      if (rateLimit.limited) {
        await ctx.reply('⏱ Please wait a moment before making another request.');
        return;
      }
    }

    const userInfo = getUserInfo(ctx);
    const url = pending.url;

    if (callbackData === 'ytq_audio') {
      await ctx.answerCbQuery('🎵 Downloading audio...');
      await ctx.deleteMessage().catch(() => {});
      this.processAudioDownload(ctx, url, userInfo, pending.originalMessageId).catch(err => {
        logger.error(`Background YouTube audio error for ${userInfo}:`, err);
      });
      return;
    }

    let downloadOptions = null;
    let qualityLabel = 'video';

    if (callbackData === 'ytq_1080') {
      downloadOptions = {
        format: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best',
        qualityName: '1080p mp4'
      };
      qualityLabel = '1080p';
    } else if (callbackData === 'ytq_720') {
      downloadOptions = {
        format: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best',
        qualityName: '720p mp4'
      };
      qualityLabel = '720p';
    } else if (callbackData === 'ytq_480') {
      downloadOptions = {
        format: 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]/best',
        qualityName: '480p mp4'
      };
      qualityLabel = '480p';
    }

    await ctx.answerCbQuery(`🎬 Downloading ${qualityLabel}...`);
    await ctx.deleteMessage().catch(() => {});

    this.processVideoDownload(ctx, url, downloadOptions, userInfo, pending.originalMessageId).catch(err => {
      logger.error(`Background YouTube download error for ${userInfo}:`, err);
    });
  }

  async processVideoDownload(ctx, url, downloadOptions, userInfo, originalMessageId) {
    const statusMessage = await ctx.reply('⏳ Processing your request...');
    let filePath = null;
    let thumbnailPath = null;

    try {
      const served = await tryServeFromCache(
        ctx,
        url,
        statusMessage.message_id,
        originalMessageId,
        userInfo,
        'video',
        (sentMsg, cached) => {
          registerPendingAudioExtract(sentMsg.message_id, {
            videoFileId: sentMsg.video.file_id,
            thumbnailFileId: sentMsg.video.thumbnail?.file_id || sentMsg.video.thumb?.file_id,
            userId: ctx.from?.id,
            title: cached.title,
            author: cached.author
          });
        }
      );
      if (served) return;

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

          const result = await videoService.download(url, { ...downloadOptions, signal }, onProgress);
          progressReporter.stop();
          filePath = result.filePath;
          thumbnailPath = result.thumbnailPath;

          logger.info(`YouTube video downloaded, platform: ${result.info.platform}`);

          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );

          const sender = getSenderInfo(ctx);
          const caption = buildCaption(sender, url, result.info);

          const sentMessages = await sendMediaToTelegram(
            ctx,
            [{ type: 'video', path: result.filePath, thumbnailPath: thumbnailPath || undefined }],
            caption,
            { width: result.width, height: result.height, duration: result.duration }
          );
          cacheSentMedia(url, sentMessages, result.info, result);

          if (sentMessages && sentMessages.length > 0) {
            const sentVideo = sentMessages[0];
            try {
              await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, sentVideo.message_id, null, {
                inline_keyboard: [[{ text: '🎵 Audio', callback_data: 'yt_audio' }]]
              });
            } catch {}

            registerPendingAudioExtract(sentVideo.message_id, {
              videoFileId: sentVideo.video.file_id,
              thumbnailFileId: sentVideo.video.thumbnail?.file_id || sentVideo.video.thumb?.file_id,
              userId: ctx.from?.id,
              title: result.info.title,
              author: result.info.author
            });
          }

          await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
          logger.info(`YouTube video sent successfully to ${userInfo}`);
        } finally {
          progressReporter.stop();
        }
      }, { ctx, statusMessageId: statusMessage.message_id });
    } catch (error) {
      await this.sendErrorMessage(ctx, statusMessage.message_id, error, userInfo, false);
    } finally {
      await this.cleanupFiles([filePath, thumbnailPath]);
    }
  }

  async processAudioDownload(ctx, url, userInfo, originalMessageId) {
    const statusMessage = await ctx.reply('⏳ Processing your request...');
    let filePath = null;
    let thumbnailPath = null;

    try {
      if (await tryServeFromCache(ctx, url, statusMessage.message_id, originalMessageId, userInfo, 'audio')) {
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
            '⬇️ Downloading audio...'
          );

          const result = await videoService.download(url, {
            format: 'bestaudio[ext=m4a]/bestaudio/best',
            qualityName: 'best audio',
            signal
          }, onProgress);

          progressReporter.stop();
          filePath = result.filePath;
          thumbnailPath = result.thumbnailPath;

          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '🎵 Converting & uploading audio...'
          );

          const audioResult = await audioService.convertToMp3(filePath, thumbnailPath, { signal });

          const audioOptions = {
            title: result.info?.title || audioResult.title || 'Audio',
            performer: result.info?.author || audioResult.artist || 'Unknown',
            duration: audioResult.duration || undefined
          };

          if (thumbnailPath) {
            audioOptions.thumbnail = getFileForTelegram(thumbnailPath);
          }

          const sentAudio = await ctx.replyWithAudio(
            getFileForTelegram(audioResult.audioPath),
            audioOptions
          );

          if (sentAudio && ctx.chat?.id) {
            const undoService = require('../../../services/undo.service');
            undoService.record(ctx.chat.id, [sentAudio.message_id], ctx.from?.id);
          }

          cacheSentMedia(url, [sentAudio], result.info, result);

          await cleanupFile(audioResult.audioPath);
          await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
          logger.info(`YouTube audio sent successfully to ${userInfo}`);
        } finally {
          progressReporter.stop();
        }
      }, { ctx, statusMessageId: statusMessage.message_id });
    } catch (error) {
      if (error?.message === 'DOWNLOAD_CANCELLED' || error?.name === 'AbortError') {
        logger.info(`YouTube audio download cancelled for ${userInfo}`);
        return;
      }
      logger.error(`YouTube audio download failed for ${userInfo}: ${error.message}`);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        `❌ ${error.message}`
      ).catch(() => {});
    } finally {
      await this.cleanupFiles([filePath, thumbnailPath]);
    }
  }
}

module.exports = YouTubeStrategy;
