const BaseStrategy = require('./base.strategy');
const soundcloudService = require('../../../services/soundcloud.service');
const queueService = require('../../../services/queue.service');
const undoService = require('../../../services/undo.service');
const cacheService = require('../../../services/cache.service');
const { tryServeFromCache, cacheSentMedia } = require('../common/cache-helper');
const logger = require('../../../utils/logger');
const {
  getFileForTelegram,
  renderProgressBar,
  getUserInfo,
  cleanupFile,
  escapeHtml
} = require('../../../utils/helpers');
const { getSenderInfo } = require('../common/telegram-sender');
const { downloadLimiter } = require('../../../middleware/rate-limit.middleware');
const config = require('../../../config');

class SoundCloudStrategy extends BaseStrategy {
  constructor() {
    super('SoundCloud');
    this.pendingSoundCloudPrompts = new Map();
    this.activePlaylists = new Map();
  }

  canHandle(url) {
    return soundcloudService.isSoundCloudUrl(url);
  }

  /**
   * Main entry point for SoundCloud links.
   * @param {object} ctx - Telegraf context
   * @param {object} options - { url, userInfo, originalMessageId, statusMessage }
   */
  async handle(ctx, options) {
    const { url, userInfo, originalMessageId } = options;
    logger.info(`SoundCloud link detected from ${userInfo}: ${url}`);

    const statusMessage = options.statusMessage || await ctx.reply('⏳ Fetching SoundCloud info...');

    try {
      // 1. Check cache first before querying metadata
      if (await tryServeFromCache(ctx, url, statusMessage.message_id, originalMessageId, userInfo, 'audio')) {
        return;
      }

      // 2. Fetch metadata
      const meta = await soundcloudService.getMetadata(url);

      if (meta.type === 'set') {
        return this.promptPlaylist(ctx, meta, url, userInfo, originalMessageId, statusMessage);
      }

      // Single track download
      await this.handleTrack(ctx, meta, url, userInfo, originalMessageId, statusMessage);
    } catch (error) {
      await this.sendErrorMessage(ctx, statusMessage.message_id, error, userInfo, false);
    }
  }

  /**
   * Download and send a single SoundCloud track.
   * @param {object} ctx
   * @param {object} meta - Metadata from soundcloudService
   * @param {string} url - Original request URL
   * @param {string} userInfo
   * @param {number} originalMessageId
   * @param {object} statusMessage
   */
  async handleTrack(ctx, meta, url, userInfo, originalMessageId, statusMessage) {
    const canonicalUrl = meta.url || url;

    // Check canonical URL in cache if different from input URL
    if (canonicalUrl !== url && await tryServeFromCache(ctx, canonicalUrl, statusMessage.message_id, originalMessageId, userInfo, 'audio')) {
      return;
    }

    await queueService.enqueue(async ({ signal } = {}) => {
      const progressReporter = queueService.createProgressReporter(ctx, statusMessage.message_id);
      const onProgress = ({ percent, speed, eta }) => {
        progressReporter.update(renderProgressBar(percent, speed, eta));
      };

      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          `⬇️ Downloading "${meta.title}" by ${meta.artist}...`
        ).catch(() => {});

        const result = await soundcloudService.downloadAndTagTrack(meta, { signal, onProgress });
        progressReporter.stop();

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          '📤 Uploading to Telegram...'
        ).catch(() => {});

        const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
        const audioOpts = {
          title: result.title,
          performer: result.artist,
          duration: result.duration
        };

        if (isGroup) {
          const sender = getSenderInfo(ctx);
          audioOpts.caption = `Sent by ${sender.caption}`;
          audioOpts.parse_mode = 'HTML';
        }

        if (result.thumbnailPath) {
          audioOpts.thumbnail = getFileForTelegram(result.thumbnailPath);
        }

        const sentAudio = await ctx.replyWithAudio(
          getFileForTelegram(result.audioPath),
          audioOpts
        );

        if (sentAudio && ctx.chat?.id) {
          undoService.record(ctx.chat.id, [sentAudio.message_id], ctx.from?.id);

          const cachePayload = {
            platform: 'SoundCloud',
            title: result.title,
            author: result.artist,
            duration: result.duration
          };
          const cacheMeta = {
            duration: result.duration,
            fileSize: result.fileSize
          };

          cacheSentMedia(canonicalUrl, [sentAudio], cachePayload, cacheMeta);
          if (url && url !== canonicalUrl) {
            cacheSentMedia(url, [sentAudio], cachePayload, cacheMeta);
          }
        }

        await result.cleanup();

        // Delete status and user trigger message
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
        } catch {}
        if (originalMessageId) {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, originalMessageId);
          } catch {}
        }

        logger.info(`SoundCloud track "${meta.title}" sent successfully to ${userInfo}`);
      } finally {
        progressReporter.stop();
      }
    }, { ctx, statusMessageId: statusMessage.message_id, originalMessageId });
  }

  /**
   * Display confirmation prompt with track count for SoundCloud playlists/sets.
   * @param {object} ctx
   * @param {object} entity - Set metadata from soundcloudService
   * @param {string} url
   * @param {string} userInfo
   * @param {number} originalMessageId
   * @param {object} statusMessage
   */
  async promptPlaylist(ctx, entity, url, userInfo, originalMessageId, statusMessage) {
    try {
      if (!entity.tracks || entity.tracks.length === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          '⚠️ <b>SoundCloud Set is empty</b>\n\n💡 This set does not contain any playable tracks.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const count = entity.tracks.length;
      const confirmText = [
        `🎵 <b>SoundCloud Set: ${escapeHtml(entity.title)}</b>`,
        `👤 Artist: ${escapeHtml(entity.artist)}`,
        `📀 Tracks: ${count}`,
        '',
        'Do you want to download all tracks into Telegram?'
      ].join('\n');

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        confirmText,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: `⬇️ Download All (${count} tracks)`, callback_data: 'sc_download' },
                { text: '❌ Cancel', callback_data: 'sc_cancel' }
              ]
            ]
          }
        }
      );

      this.pendingSoundCloudPrompts.set(statusMessage.message_id, {
        userId: ctx.from?.id,
        chatId: ctx.chat.id,
        url,
        entity,
        originalMessageId
      });

      // Auto-expire prompt after 2 minutes
      const timer = setTimeout(() => {
        if (this.pendingSoundCloudPrompts.has(statusMessage.message_id)) {
          this.pendingSoundCloudPrompts.delete(statusMessage.message_id);
          ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
        }
      }, 120000);
      timer.unref?.();
    } catch (error) {
      await this.sendErrorMessage(ctx, statusMessage.message_id, error, userInfo, false);
    }
  }

  /**
   * Handle callback query for SoundCloud confirmation prompt.
   * @param {object} ctx
   */
  async handleCallback(ctx) {
    const callbackData = ctx.callbackQuery?.data;
    const messageId = ctx.callbackQuery?.message?.message_id;
    const userId = ctx.from?.id;

    const pending = this.pendingSoundCloudPrompts.get(messageId);
    if (!pending) {
      await ctx.answerCbQuery('⚠️ This request has expired.');
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (pending.userId && userId && pending.userId !== userId) {
      await ctx.answerCbQuery('⚠️ Only the user who sent the link can confirm this download.', { show_alert: true });
      return;
    }

    this.pendingSoundCloudPrompts.delete(messageId);

    if (callbackData === 'sc_cancel') {
      await ctx.answerCbQuery('❌ Download cancelled');
      if (ctx.telegram?.editMessageText) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            null,
            '❌ <b>Download cancelled.</b>',
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
          );
          const t = setTimeout(() => {
            ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
          }, 3000);
          t.unref?.();
          return;
        } catch {}
      }
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (callbackData === 'sc_download') {
      await ctx.answerCbQuery('🎵 Starting SoundCloud set download...');

      // Immediately remove buttons and show initial progress card
      const totalTracks = pending.entity?.tracks?.length || 0;
      if (ctx.telegram?.editMessageText) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            null,
            [
              `🎵 <b>Downloading: ${escapeHtml(pending.entity.title)}</b>`,
              `[░░░░░░░░░░] 0% (0/${totalTracks} sent)`,
              '🎶 <i>Starting parallel download engine...</i>',
              '',
              '💡 Send /cancel to stop set download'
            ].join('\n'),
            {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [] }
            }
          );
        } catch {}
      }

      const userInfo = getUserInfo(ctx);
      this.processPlaylistDownload(ctx, pending.entity, userInfo, messageId, pending.originalMessageId).catch(err => {
        if (err.message === 'DOWNLOAD_CANCELLED') {
          logger.info(`SoundCloud set "${pending.entity.title}" download cancelled by ${userInfo}`);
          return;
        }
        logger.error(`SoundCloud set background error for ${userInfo}:`, err);
      });
    }
  }

  /**
   * Pipelined parallel SoundCloud set download with sliding window concurrency,
   * in-order Telegram delivery, and cancellation support.
   */
  async processPlaylistDownload(ctx, entity, userInfo, statusMessageId, originalMessageId) {
    const total = entity.tracks.length;
    let completedCount = 0;
    let failedCount = 0;
    const failedTracks = [];

    const playlistAbortController = new AbortController();
    const playlistSignal = playlistAbortController.signal;

    this.activePlaylists.set(statusMessageId, {
      abortController: playlistAbortController,
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      statusMessageId,
      originalMessageId,
      title: entity.title,
      total,
      getCompletedCount: () => completedCount
    });

    const sleepWithSignal = (ms, signal) => {
      if (signal?.aborted) return Promise.reject(new Error('DOWNLOAD_CANCELLED'));
      return new Promise((resolve, reject) => {
        let timer = null;
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('DOWNLOAD_CANCELLED'));
        };
        timer = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        timer.unref?.();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
    };

    const concurrency = Math.max(1, Math.min(config.spotify?.concurrency || 3, 4));
    const maxLookahead = concurrency;

    const pipelineBuffer = new Map();
    let nextIndexToDownload = 0;
    let nextIndexToSend = 0;
    let activeDownloadWorkers = 0;

    let isUpdatingStatus = false;
    let lastStatusUpdate = 0;

    const updateStatusCard = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastStatusUpdate < 2500) return;
      if (isUpdatingStatus) return;

      isUpdatingStatus = true;
      lastStatusUpdate = now;

      try {
        const percent = total > 0 ? (completedCount / total) * 100 : 0;
        const progressBar = renderProgressBar(percent, '', '');
        const currentItemText = nextIndexToSend < total
          ? `🎵 <b>Sending #${nextIndexToSend + 1}:</b> ${escapeHtml(entity.tracks[nextIndexToSend].title)}`
          : '🏁 <i>Finalizing delivery...</i>';

        const lines = [
          `🎵 <b>Downloading: ${escapeHtml(entity.title)}</b>`,
          `${progressBar} (${completedCount}/${total} sent)`,
          currentItemText
        ];

        if (failedCount > 0) {
          lines.push(`⚠️ Failed: ${failedCount}`);
        }

        lines.push('', '💡 Send /cancel to stop set download');

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessageId,
          null,
          lines.join('\n'),
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        if (!err.message?.includes('message is not modified')) {
          logger.debug(`Could not update SoundCloud set progress card: ${err.message}`);
        }
      } finally {
        isUpdatingStatus = false;
      }
    };

    try {
      while (nextIndexToSend < total) {
        if (playlistSignal.aborted) {
          throw new Error('DOWNLOAD_CANCELLED');
        }

        // Spawn parallel download workers up to concurrency / lookahead window
        while (
          activeDownloadWorkers < concurrency &&
          nextIndexToDownload < total &&
          (nextIndexToDownload - nextIndexToSend) < maxLookahead
        ) {
          const trackIndex = nextIndexToDownload++;
          const track = entity.tracks[trackIndex];
          activeDownloadWorkers++;

          (async () => {
            try {
              if (playlistSignal.aborted) return;

              // Check cache first for track
              const trackCanonicalUrl = track.url || `https://soundcloud.com/track/${track.id}`;
              const cached = cacheService.get(trackCanonicalUrl);

              if (cached && cached.file_id && cached.file_type === 'audio') {
                pipelineBuffer.set(trackIndex, {
                  cached: true,
                  fileId: cached.file_id,
                  track
                });
                return;
              }

              // Direct SoundCloud download & conversion
              const prepResult = await soundcloudService.downloadAndTagTrack(track, {
                signal: playlistSignal
              });

              pipelineBuffer.set(trackIndex, {
                cached: false,
                prepResult,
                track
              });
            } catch (err) {
              if (playlistSignal.aborted) return;
              logger.warn(`Failed preparing SoundCloud track "${track.title}" from set: ${err.message}`);
              pipelineBuffer.set(trackIndex, {
                failed: true,
                error: err,
                track
              });
            } finally {
              activeDownloadWorkers--;
            }
          })();
        }

        // Sequential emission: deliver track nextIndexToSend if ready
        if (pipelineBuffer.has(nextIndexToSend)) {
          const item = pipelineBuffer.get(nextIndexToSend);
          pipelineBuffer.delete(nextIndexToSend);

          if (playlistSignal.aborted) {
            if (item.prepResult?.cleanup) await item.prepResult.cleanup();
            throw new Error('DOWNLOAD_CANCELLED');
          }

          if (item.failed) {
            failedCount++;
            failedTracks.push({
              title: item.track.title,
              artist: item.track.artist,
              error: item.error?.message || 'Audio extraction failed'
            });
            logger.warn(`Skipping failed track #${nextIndexToSend + 1}: ${item.track.title}`);
          } else {
            try {
              let sentAudio = null;
              const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
              const sender = getSenderInfo(ctx);

              if (item.cached) {
                const audioOpts = {
                  title: item.track.title,
                  performer: item.track.artist
                };
                if (isGroup && sender?.caption) {
                  audioOpts.caption = `Sent by ${sender.caption}`;
                  audioOpts.parse_mode = 'HTML';
                }
                sentAudio = await ctx.replyWithAudio(item.fileId, audioOpts);
              } else {
                const audioOpts = {
                  title: item.prepResult.title,
                  performer: item.prepResult.artist,
                  duration: item.prepResult.duration
                };
                if (isGroup && sender?.caption) {
                  audioOpts.caption = `Sent by ${sender.caption}`;
                  audioOpts.parse_mode = 'HTML';
                }
                if (item.prepResult.thumbnailPath) {
                  audioOpts.thumbnail = getFileForTelegram(item.prepResult.thumbnailPath);
                }

                sentAudio = await ctx.replyWithAudio(
                  getFileForTelegram(item.prepResult.audioPath),
                  audioOpts
                );

                if (sentAudio && item.track.url) {
                  cacheSentMedia(item.track.url, [sentAudio], {
                    platform: 'SoundCloud',
                    title: item.prepResult.title,
                    author: item.prepResult.artist,
                    duration: item.prepResult.duration
                  }, {
                    duration: item.prepResult.duration,
                    fileSize: item.prepResult.fileSize
                  });
                }
              }

              if (sentAudio) {
                undoService.record(ctx.chat.id, [sentAudio.message_id], ctx.from?.id);
                completedCount++;
              }
            } catch (sendErr) {
              failedCount++;
              failedTracks.push({
                title: item.track.title,
                artist: item.track.artist,
                error: sendErr.message || 'Telegram upload error'
              });
              logger.error(`Failed sending track "${item.track.title}" to Telegram: ${sendErr.message}`);
            } finally {
              if (item.prepResult?.cleanup) {
                await item.prepResult.cleanup();
              }
            }
          }

          nextIndexToSend++;
          await updateStatusCard(false);

          // Telegram rate limit guard between consecutive audio messages
          await sleepWithSignal(600, playlistSignal);
        } else {
          // Wait briefly for active worker to complete
          await sleepWithSignal(100, playlistSignal);
        }
      }

      // Cleanup remaining buffered files
      for (const item of pipelineBuffer.values()) {
        if (item?.prepResult?.cleanup) {
          await item.prepResult.cleanup().catch(() => {});
        }
      }

      logger.info(`SoundCloud set "${entity.title}" completed (${completedCount} sent, ${failedCount} failed)`);

      // Delete status message and trigger message
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMessageId);
      } catch {}
      if (originalMessageId) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, originalMessageId);
        } catch {}
      }

      // If any tracks failed, send a summary report
      if (failedTracks.length > 0) {
        const reportLines = [
          `⚠️ <b>SoundCloud set completed with some missing tracks:</b>`,
          `<b>${completedCount}/${total}</b> tracks delivered successfully.\n`,
          `<b>Missing tracks (${failedTracks.length}):</b>`
        ];

        for (const ft of failedTracks.slice(0, 10)) {
          reportLines.push(`• <b>${escapeHtml(ft.title)}</b> — <i>${escapeHtml(ft.artist)}</i>`);
        }
        if (failedTracks.length > 10) {
          reportLines.push(`• <i>...and ${failedTracks.length - 10} more</i>`);
        }

        reportLines.push('\n💡 <i>Tracks may be geo-restricted or removed from SoundCloud.</i>');

        await ctx.reply(reportLines.join('\n'), { parse_mode: 'HTML' });
      }
    } catch (err) {
      // Clean up all pending items in buffer
      for (const item of pipelineBuffer.values()) {
        if (item?.prepResult?.cleanup) {
          await item.prepResult.cleanup().catch(() => {});
        }
      }

      if (err.message === 'DOWNLOAD_CANCELLED') {
        throw err;
      }

      logger.error(`SoundCloud set download error for ${userInfo}:`, err);
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessageId,
          null,
          `❌ <b>SoundCloud set download failed:</b> ${escapeHtml(err.message)}`,
          { parse_mode: 'HTML' }
        );
      } catch {}
    } finally {
      this.activePlaylists.delete(statusMessageId);
    }
  }

  /**
   * Cancel pending SoundCloud prompt if matches criteria.
   * Invoked by /cancel handler.
   */
  cancelPending(chatId, targetMessageId = null, userId = null, isChatAdmin = false) {
    const keyChatId = Number(chatId);
    const parsedTargetId = targetMessageId ? Number(targetMessageId) : null;
    const parsedUserId = userId ? Number(userId) : null;

    for (const [msgId, pending] of Array.from(this.pendingSoundCloudPrompts.entries()).reverse()) {
      if (Number(pending.chatId) === keyChatId) {
        if (parsedTargetId && parsedTargetId !== Number(msgId) && parsedTargetId !== Number(pending.originalMessageId)) {
          continue;
        }

        if (pending.userId && parsedUserId && Number(pending.userId) !== parsedUserId && !isChatAdmin) {
          return { unauthorized: true };
        }

        this.pendingSoundCloudPrompts.delete(msgId);
        return { messageId: msgId, pending };
      }
    }
    return null;
  }

  /**
   * Cancel an active SoundCloud set download if running in this chat.
   * Invoked by /cancel handler.
   */
  cancelActive(chatId, targetMessageId = null, userId = null, isChatAdmin = false) {
    for (const [statusMsgId, active] of this.activePlaylists.entries()) {
      if (active.chatId === chatId) {
        if (targetMessageId && targetMessageId !== active.statusMessageId && targetMessageId !== active.originalMessageId) {
          continue;
        }

        if (active.userId && userId && active.userId !== userId && !isChatAdmin) {
          return { unauthorized: true };
        }

        if (active.abortController) {
          active.abortController.abort();
        }

        this.activePlaylists.delete(statusMsgId);
        return active;
      }
    }
    return null;
  }
}

module.exports = SoundCloudStrategy;
