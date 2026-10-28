const BaseStrategy = require('./base.strategy');
const spotifyService = require('../../../services/spotify.service');
const spotifyAudioService = require('../../../services/spotify-audio.service');
const queueService = require('../../../services/queue.service');
const undoService = require('../../../services/undo.service');
const logger = require('../../../utils/logger');
const { getFileForTelegram, renderProgressBar, getUserInfo, cleanupFile, escapeHtml } = require('../../../utils/helpers');
const { getSenderInfo } = require('../common/telegram-sender');
const { downloadLimiter } = require('../../../middleware/rate-limit.middleware');
const config = require('../../../config');

class SpotifyStrategy extends BaseStrategy {
  constructor() {
    super('Spotify');
    this.pendingSpotifyPrompts = new Map();
    this.activePlaylists = new Map();
  }

  canHandle(url) {
    return spotifyService.isSpotifyUrl(url);
  }

  /**
   * Main entry point for Spotify links.
   * @param {object} ctx - Telegraf context
   * @param {object} options - { url, userInfo, originalMessageId }
   */
  async handle(ctx, options) {
    const { url, userInfo, originalMessageId } = options;
    logger.info(`Spotify link detected from ${userInfo}: ${url}`);

    const parsed = spotifyService.parseUrl(url);
    if (!parsed) {
      return ctx.reply('⚠️ Invalid or unsupported Spotify URL.');
    }

    // Single track download (dispatch asynchronously in background)
    if (parsed.type === 'track') {
      this.handleTrack(ctx, parsed.id, url, userInfo, originalMessageId).catch(error => {
        logger.error(`Spotify track error for ${userInfo}:`, error);
      });
      return;
    }

    // Playlist or Album download
    if (parsed.type === 'playlist' || parsed.type === 'album') {
      return this.promptPlaylist(ctx, parsed.type, parsed.id, url, userInfo, originalMessageId);
    }

    return ctx.reply(`⚠️ Spotify ${parsed.type}s are not currently supported for direct download.`);
  }

  /**
   * Download and send a single Spotify track.
   */
  async handleTrack(ctx, trackId, url, userInfo, originalMessageId) {
    const statusMessage = await ctx.reply('⏳ Fetching Spotify track info...');

    try {
      const track = await spotifyService.getTrack(trackId);

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
            `⬇️ Downloading "${track.title}" by ${track.artist}...`
          );

          const result = await spotifyAudioService.downloadAndTagTrack(track, { signal, onProgress });
          progressReporter.stop();

          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );

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

          logger.info(`Spotify track "${track.title}" sent successfully to ${userInfo}`);
        } finally {
          progressReporter.stop();
        }
      }, { ctx, statusMessageId: statusMessage.message_id, originalMessageId });
    } catch (error) {
      await this.sendErrorMessage(ctx, statusMessage.message_id, error, userInfo, false);
    }
  }

  /**
   * Display confirmation prompt before starting playlist or album download.
   */
  async promptPlaylist(ctx, type, id, url, userInfo, originalMessageId) {
    const statusMessage = await ctx.reply(`⏳ Fetching Spotify ${type} info...`);

    try {
      const entity = type === 'album'
        ? await spotifyService.getAlbum(id)
        : await spotifyService.getPlaylist(id);

      if (!entity.tracks || entity.tracks.length === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          `⚠️ <b>Spotify ${type === 'album' ? 'Album' : 'Playlist'} is empty</b>\n\n💡 This ${type} does not contain any playable tracks.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const typeLabel = type === 'album' ? 'Album' : 'Playlist';
      const authorLabel = type === 'album' ? `👤 Artist: ${entity.artist}` : `👤 Curator: ${entity.curator}`;
      const count = entity.tracks.length;

      const confirmText = [
        `🎵 <b>Spotify ${typeLabel}: ${entity.title}</b>`,
        authorLabel,
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
                { text: `⬇️ Download All (${count} tracks)`, callback_data: 'spot_download' },
                { text: '❌ Cancel', callback_data: 'spot_cancel' }
              ]
            ]
          }
        }
      );

      this.pendingSpotifyPrompts.set(statusMessage.message_id, {
        userId: ctx.from?.id,
        chatId: ctx.chat.id,
        type,
        id,
        url,
        entity,
        originalMessageId
      });

      // Auto-expire prompt after 2 minutes
      setTimeout(() => {
        if (this.pendingSpotifyPrompts.has(statusMessage.message_id)) {
          this.pendingSpotifyPrompts.delete(statusMessage.message_id);
          ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
        }
      }, 120000);
    } catch (error) {
      await this.sendErrorMessage(ctx, statusMessage.message_id, error, userInfo, false);
    }
  }

  /**
   * Handle inline button click (Download All or Cancel).
   * @param {object} ctx
   */
  async handleCallback(ctx) {
    const callbackData = ctx.callbackQuery?.data;
    const messageId = ctx.callbackQuery?.message?.message_id;
    const userId = ctx.from?.id;

    const pending = this.pendingSpotifyPrompts.get(messageId);
    if (!pending) {
      await ctx.answerCbQuery('⚠️ This request has expired.');
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (pending.userId && pending.userId !== userId) {
      await ctx.answerCbQuery('⚠️ Only the person who shared the link can start the download.', { show_alert: true });
      return;
    }

    this.pendingSpotifyPrompts.delete(messageId);

    if (callbackData === 'spot_cancel') {
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

    if (callbackData === 'spot_download') {
      await ctx.answerCbQuery('🎵 Starting playlist download...');

      // Immediately remove buttons and show initial progress card so user has 0ms visual feedback
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
              `🎶 <i>Starting parallel download engine...</i>`,
              '',
              `💡 Send /cancel to stop playlist download`
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
          logger.info(`Spotify playlist "${pending.entity.title}" download cancelled by ${userInfo}`);
          return;
        }
        logger.error(`Spotify playlist background error for ${userInfo}:`, err);
      });
    }
  }

  /**
   * Pipelined parallel playlist download with sliding window concurrency, in-order Telegram delivery,
   * detailed failed track tracking, and prompt cancellation.
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
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
    };

    const concurrency = Math.max(1, Math.min(config.spotify?.concurrency || 3, 4));
    const maxLookahead = concurrency;

    logger.info(`Starting batch download of Spotify playlist "${entity.title}" (${total} tracks, concurrency: ${concurrency}) for ${userInfo}`);

    const trackPromises = new Array(total);
    const trackResolvers = new Array(total);
    for (let i = 0; i < total; i++) {
      trackPromises[i] = new Promise(resolve => {
        trackResolvers[i] = resolve;
      });
    }

    let nextDownloadIdx = 0;
    let sendIdx = 0;
    let workerWakeup = null;

    const prepareTrack = async (index) => {
      const track = entity.tracks[index];

      return queueService.enqueue(async ({ signal: queueSignal } = {}) => {
        const combinedAbort = new AbortController();
        const onPlaylistAbort = () => combinedAbort.abort();
        const onQueueAbort = () => combinedAbort.abort();

        playlistSignal.addEventListener('abort', onPlaylistAbort, { once: true });
        queueSignal?.addEventListener('abort', onQueueAbort, { once: true });

        const signal = combinedAbort.signal;

        try {
          if (signal.aborted) {
            throw new Error('DOWNLOAD_CANCELLED');
          }

          // Fetch individual track album cover art on demand if needed
          if (!track.coverUrl && track.id && !track.id.startsWith('track_')) {
            try {
              const trackMeta = await spotifyService.getTrack(track.id);
              if (trackMeta) {
                if (trackMeta.coverUrl) track.coverUrl = trackMeta.coverUrl;
                if (trackMeta.album) track.album = trackMeta.album;
                if (trackMeta.releaseDate) track.releaseDate = trackMeta.releaseDate;
              }
            } catch (metaErr) {
              logger.warn(`Could not fetch individual cover for "${track.title}": ${metaErr.message}`);
            }
          }

          if (!track.coverUrl && track.playlistCoverUrl) {
            track.coverUrl = track.playlistCoverUrl;
          }

          if (signal.aborted) {
            throw new Error('DOWNLOAD_CANCELLED');
          }

          const result = await spotifyAudioService.downloadAndTagTrack(track, { signal });
          return { success: true, track, result };
        } catch (err) {
          if (signal.aborted || err.message === 'DOWNLOAD_CANCELLED') {
            throw new Error('DOWNLOAD_CANCELLED');
          }
          logger.warn(`Failed preparing track "${track.title}" from playlist: ${err.message}`);
          return { success: false, track, error: err.message };
        } finally {
          playlistSignal.removeEventListener('abort', onPlaylistAbort);
          if (queueSignal) queueSignal.removeEventListener('abort', onQueueAbort);
        }
      }, { ctx, statusMessageId, originalMessageId, isPlaylistTrack: true });
    };

    const runWorker = async (workerId) => {
      while (true) {
        if (playlistSignal.aborted) break;

        while (nextDownloadIdx < total && (nextDownloadIdx - sendIdx) >= maxLookahead) {
          if (playlistSignal.aborted) break;
          await new Promise(r => { workerWakeup = r; });
        }

        if (playlistSignal.aborted || nextDownloadIdx >= total) break;
        const currentIdx = nextDownloadIdx++;

        try {
          const outcome = await prepareTrack(currentIdx);
          if (playlistSignal.aborted) {
            if (outcome.result?.cleanup) await outcome.result.cleanup().catch(() => {});
            trackResolvers[currentIdx]({ success: false, track: entity.tracks[currentIdx], error: 'DOWNLOAD_CANCELLED' });
            break;
          }
          trackResolvers[currentIdx](outcome);
        } catch (workerErr) {
          if (playlistSignal.aborted || workerErr.message === 'DOWNLOAD_CANCELLED') {
            trackResolvers[currentIdx]({ success: false, track: entity.tracks[currentIdx], error: 'DOWNLOAD_CANCELLED' });
            break;
          }
          trackResolvers[currentIdx]({ success: false, track: entity.tracks[currentIdx], error: workerErr.message });
        }
      }
    };

    const workers = Array.from({ length: concurrency }, (_, id) => runWorker(id));
    let lastProgressEdit = 0;

    try {
      for (let i = 0; i < total; i++) {
        if (playlistSignal.aborted) {
          throw new Error('DOWNLOAD_CANCELLED');
        }

        const outcome = await trackPromises[i];
        if (playlistSignal.aborted) {
          if (outcome?.result?.cleanup) await outcome.result.cleanup().catch(() => {});
          throw new Error('DOWNLOAD_CANCELLED');
        }

        const track = outcome.track || entity.tracks[i];

        if (!outcome.success || !outcome.result) {
          failedCount++;
          failedTracks.push({
            title: track.title,
            artist: track.artist || (track.artists && track.artists.join(', ')) || 'Unknown Artist',
            error: outcome.error || 'Failed to download'
          });
        } else {
          const result = outcome.result;
          try {
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

            let sent = null;
            let retries = 3;
            while (retries > 0 && !sent) {
              if (playlistSignal.aborted) {
                await result.cleanup();
                throw new Error('DOWNLOAD_CANCELLED');
              }

              try {
                sent = await ctx.telegram.callApi('sendAudio', {
                  chat_id: ctx.chat.id,
                  audio: getFileForTelegram(result.audioPath),
                  ...audioOpts
                }, playlistSignal ? { signal: playlistSignal } : {});
              } catch (sendErr) {
                if (playlistSignal.aborted || sendErr.name === 'AbortError' || sendErr.code === 'ERR_ABORTED') {
                  await result.cleanup();
                  throw new Error('DOWNLOAD_CANCELLED');
                }
                if (sendErr.parameters?.retry_after) {
                  const waitSec = sendErr.parameters.retry_after + 1;
                  logger.warn(`Telegram flood limit hit during playlist! Waiting ${waitSec}s`);
                  await sleepWithSignal(waitSec * 1000, playlistSignal);
                  retries--;
                } else {
                  throw sendErr;
                }
              }
            }

            if (playlistSignal.aborted) {
              if (sent?.message_id) {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id); } catch {}
              }
              await result.cleanup();
              throw new Error('DOWNLOAD_CANCELLED');
            }

            if (sent && ctx.chat?.id) {
              undoService.record(ctx.chat.id, [sent.message_id], ctx.from?.id);
            }

            completedCount++;
          } catch (sendErr) {
            if (playlistSignal.aborted) {
              await result.cleanup();
              throw new Error('DOWNLOAD_CANCELLED');
            }
            logger.warn(`Failed to send track "${track.title}" to Telegram: ${sendErr.message}`);
            failedCount++;
            failedTracks.push({
              title: track.title,
              artist: track.artist || 'Unknown Artist',
              error: sendErr.message
            });
          } finally {
            await result.cleanup();
          }
        }

        sendIdx++;
        if (workerWakeup) {
          const wake = workerWakeup;
          workerWakeup = null;
          wake();
        }

        // Throttled progress card update (every 2.0s or on the last track)
        const now = Date.now();
        if (now - lastProgressEdit >= 2000 || i === total - 1) {
          lastProgressEdit = now;
          const percent = Math.round(((i + 1) / total) * 100);
          const totalBars = 10;
          const filled = Math.max(0, Math.min(totalBars, Math.round((percent / 100) * totalBars)));
          const empty = totalBars - filled;
          const bar = '█'.repeat(filled) + '░'.repeat(empty);

          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessageId,
              null,
              [
                `🎵 <b>Downloading: ${escapeHtml(entity.title)}</b>`,
                `[${bar}] ${percent}% (${completedCount}/${total} sent)`,
                `🎶 <i>${escapeHtml(track.title)} — ${escapeHtml(track.artist)}</i>`,
                '',
                `💡 Send /cancel to stop playlist download`
              ].join('\n'),
              { parse_mode: 'HTML' }
            );
          } catch {}
        }

        // Pacing delay between sending tracks
        await sleepWithSignal(1000, playlistSignal);
      }

      if (playlistSignal.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }

      // Finish playlist notifications
      if (failedTracks.length === 0) {
        const summaryText = `✅ <b>Playlist complete!</b> Sent all ${completedCount} tracks.`;
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMessageId, null, summaryText, { parse_mode: 'HTML' });
          setTimeout(() => {
            ctx.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
          }, 10000);
        } catch {}
      } else {
        // Detailed report of failed tracks sent as permanent message to user
        const header = `⚠️ <b>Playlist finished with issues: ${escapeHtml(entity.title)}</b>\n` +
          `• Successfully sent: <b>${completedCount}/${total}</b> tracks\n` +
          `• Skipped: <b>${failedTracks.length}</b> tracks:\n\n`;

        const trackLines = failedTracks.slice(0, 30).map((t, idx) =>
          `${idx + 1}. <b>${escapeHtml(t.artist)}</b> — ${escapeHtml(t.title)}`
        ).join('\n');

        const moreText = failedTracks.length > 30 ? `\n\n<i>... and ${failedTracks.length - 30} more.</i>` : '';
        const reportText = header + trackLines + moreText;

        try {
          await ctx.reply(reportText, { parse_mode: 'HTML' });
        } catch (repErr) {
          logger.warn(`Failed sending playlist summary report: ${repErr.message}`);
        }

        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessageId,
            null,
            `⚠️ Playlist finished. ${completedCount} sent, ${failedTracks.length} skipped.`
          );
          setTimeout(() => {
            ctx.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
          }, 15000);
        } catch {}
      }

      if (originalMessageId) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, originalMessageId);
        } catch {}
      }

      logger.info(`Spotify playlist "${entity.title}" completed (${completedCount} sent, ${failedCount} failed)`);
    } finally {
      this.activePlaylists.delete(statusMessageId);
      // If cancelled, clean up any prepared results
      if (playlistSignal.aborted) {
        for (let i = 0; i < total; i++) {
          try {
            const outcome = await Promise.race([
              trackPromises[i],
              Promise.resolve(null)
            ]);
            if (outcome?.result?.cleanup) {
              await outcome.result.cleanup().catch(() => {});
            }
          } catch {}
        }
      }
      if (workerWakeup) {
        const wake = workerWakeup;
        workerWakeup = null;
        wake();
      }
      await Promise.allSettled(workers);
    }
  }

  /**
   * Cancel an in-flight active Spotify playlist download.
   * @param {string|number} chatId
   * @param {number|null} targetMessageId
   * @param {number|null} userId
   * @param {boolean} isChatAdmin
   * @returns {{ statusMessageId: number } | { unauthorized: true } | null}
   */
  cancelActive(chatId, targetMessageId = null, userId = null, isChatAdmin = false) {
    const keyChatId = Number(chatId);
    const parsedTargetId = targetMessageId ? Number(targetMessageId) : null;
    const parsedUserId = userId ? Number(userId) : null;

    for (const [msgId, active] of Array.from(this.activePlaylists.entries()).reverse()) {
      if (active.chatId && Number(active.chatId) !== keyChatId) continue;
      if (parsedTargetId && msgId !== parsedTargetId) continue;

      const isOwner = parsedUserId && active.userId === parsedUserId;
      if (!isChatAdmin && !isOwner && active.userId) {
        return { unauthorized: true };
      }

      active.abortController.abort();
      this.activePlaylists.delete(msgId);
      return {
        statusMessageId: msgId,
        title: active.title,
        total: active.total,
        getCompletedCount: active.getCompletedCount,
        active
      };
    }
    return null;
  }

  /**
   * Cancel pending Spotify confirmation prompt.
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

    for (const [msgId, pending] of Array.from(this.pendingSpotifyPrompts.entries()).reverse()) {
      if (pending.chatId && Number(pending.chatId) !== keyChatId) continue;
      if (parsedTargetId && msgId !== parsedTargetId) continue;

      const isOwner = parsedUserId && pending.userId === parsedUserId;
      if (!isChatAdmin && !isOwner && pending.userId) {
        return { unauthorized: true };
      }

      this.pendingSpotifyPrompts.delete(msgId);
      return { messageId: msgId, pending };
    }
    return null;
  }

  /**
   * Spotify-specific user-friendly error formatting.
   * @param {object} ctx
   * @param {number} statusMessageId
   * @param {Error} error
   * @param {string} userInfo
   */
  async sendErrorMessage(ctx, statusMessageId, error, userInfo) {
    if (error?.message === 'DOWNLOAD_CANCELLED' || error?.name === 'AbortError') {
      logger.info(`Spotify request cancelled for ${userInfo}`);
      return;
    }

    logger.error(`Spotify request failed for ${userInfo}: ${error.message}`);

    const rawMsg = error.message || '';
    let title = 'Spotify request failed';
    const tips = [];

    if (rawMsg.includes('not found') || rawMsg.includes('private') || rawMsg.includes('404')) {
      if (rawMsg.includes('playlist')) {
        title = 'Spotify playlist not found or is private';
        tips.push('Make sure the playlist is <b>Public</b> (in Spotify: tap <b>···</b> ➔ <b>Make Public</b>)');
        tips.push('Private, secret, or invite-only playlists cannot be accessed by the bot');
        tips.push('Ensure the link is valid and has not expired');
      } else if (rawMsg.includes('album')) {
        title = 'Spotify album not found or is unavailable';
        tips.push('The album may be unreleased, removed, or region-restricted');
        tips.push('Ensure the link is valid');
      } else {
        title = 'Spotify track not found or is unavailable';
        tips.push('The track may be region-restricted or removed from Spotify');
        tips.push('Ensure the link is valid');
      }
    } else if (rawMsg.includes('No available audio streams') || rawMsg.includes('EMPTY_AUDIO_FILE')) {
      title = 'Could not find a downloadable audio match';
      tips.push('No matching audio stream was found for this track');
      tips.push('Try searching for the song directly with /song <title>');
    } else {
      title = 'Failed to load Spotify media';
      const cleanErr = rawMsg.replace(/[_*[\]`~>#+\-=|{}.!()\\]/g, ' ').trim();
      if (cleanErr) tips.push(escapeHtml(cleanErr));
      tips.push('Please verify the link and try again in a few moments');
    }

    const tipsText = tips.map(t => `• ${t}`).join('\n');
    const messageText = `❌ <b>${title}</b>\n\n💡 <b>Troubleshooting:</b>\n${tipsText}`;

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessageId,
        null,
        messageText,
        { parse_mode: 'HTML' }
      );
    } catch {
      try {
        const plainText = messageText.replace(/<[^>]*>/g, '');
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessageId,
          null,
          plainText
        );
      } catch (finalErr) {
        logger.error(`Failed to send Spotify error text to ${userInfo}: ${finalErr.message}`);
      }
    }
  }
}

module.exports = SpotifyStrategy;
