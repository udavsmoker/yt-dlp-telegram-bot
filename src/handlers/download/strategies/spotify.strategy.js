const BaseStrategy = require('./base.strategy');
const spotifyService = require('../../../services/spotify.service');
const spotifyAudioService = require('../../../services/spotify-audio.service');
const queueService = require('../../../services/queue.service');
const undoService = require('../../../services/undo.service');
const logger = require('../../../utils/logger');
const { getFileForTelegram, renderProgressBar, getUserInfo, cleanupFile } = require('../../../utils/helpers');
const { downloadLimiter } = require('../../../middleware/rate-limit.middleware');

class SpotifyStrategy extends BaseStrategy {
  constructor() {
    super('Spotify');
    this.pendingSpotifyPrompts = new Map();
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

    // Single track download
    if (parsed.type === 'track') {
      return this.handleTrack(ctx, parsed.id, url, userInfo, originalMessageId);
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

          const audioOpts = {
            title: result.title,
            performer: result.artist,
            duration: result.duration
          };

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
          `⚠️ No tracks found in this ${type}.`
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
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (callbackData === 'spot_download') {
      await ctx.answerCbQuery('🎵 Starting playlist download...');

      const userInfo = getUserInfo(ctx);
      this.processPlaylistDownload(ctx, pending.entity, userInfo, messageId, pending.originalMessageId).catch(err => {
        logger.error(`Spotify playlist background error for ${userInfo}:`, err);
      });
    }
  }

  /**
   * Sequential playlist download pipeline with paced Telegram delivery and rate limit resilience.
   */
  async processPlaylistDownload(ctx, entity, userInfo, statusMessageId, originalMessageId) {
    const total = entity.tracks.length;
    let completedCount = 0;
    let failedCount = 0;

    await queueService.enqueue(async ({ signal } = {}) => {
      logger.info(`Starting batch download of Spotify playlist "${entity.title}" (${total} tracks) for ${userInfo}`);

      for (let i = 0; i < total; i++) {
        if (signal?.aborted) {
          throw new Error('DOWNLOAD_CANCELLED');
        }

        const track = entity.tracks[i];
        const percent = Math.round(((i + 1) / total) * 100);

        // Update playlist progress card
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessageId,
            null,
            [
              `🎵 <b>Downloading: ${entity.title}</b>`,
              `📀 Track ${i + 1}/${total} (${percent}%)`,
              `🎶 <i>${track.title} — ${track.artist}</i>`,
              '',
              `💡 Send /cancel to stop playlist download`
            ].join('\n'),
            { parse_mode: 'HTML' }
          );
        } catch {}

        try {
          // Download and transcode track
          const result = await spotifyAudioService.downloadAndTagTrack(track, { signal });

          if (signal?.aborted) {
            await result.cleanup();
            throw new Error('DOWNLOAD_CANCELLED');
          }

          const audioOpts = {
            title: result.title,
            performer: result.artist,
            duration: result.duration
          };

          if (result.thumbnailPath) {
            audioOpts.thumbnail = getFileForTelegram(result.thumbnailPath);
          }

          // Send to Telegram with 429 flood protection retry
          let sent = null;
          let retries = 3;
          while (retries > 0 && !sent && !signal?.aborted) {
            try {
              sent = await ctx.replyWithAudio(getFileForTelegram(result.audioPath), audioOpts);
            } catch (sendErr) {
              if (sendErr.parameters?.retry_after) {
                const waitSec = sendErr.parameters.retry_after + 1;
                logger.warn(`Telegram flood limit hit during playlist! Waiting ${waitSec}s`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
                retries--;
              } else {
                throw sendErr;
              }
            }
          }

          if (sent && ctx.chat?.id) {
            undoService.record(ctx.chat.id, [sent.message_id], ctx.from?.id);
          }

          await result.cleanup();
          completedCount++;

          // Pacing delay between tracks (1500ms) to avoid Telegram API flood bans
          await new Promise(r => setTimeout(r, 1500));
        } catch (trackError) {
          if (trackError.message === 'DOWNLOAD_CANCELLED' || signal?.aborted) {
            throw new Error('DOWNLOAD_CANCELLED');
          }
          logger.warn(`Failed to download track "${track.title}" from playlist: ${trackError.message}`);
          failedCount++;
          // Wait 1s and proceed to next track so one broken track doesn't kill the playlist
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Finish playlist
      const summaryText = failedCount > 0
        ? `✅ Playlist finished! Sent ${completedCount}/${total} tracks (${failedCount} unavailable).`
        : `✅ Playlist complete! Sent all ${completedCount} tracks.`;

      try {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMessageId, null, summaryText);
        setTimeout(() => {
          ctx.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
        }, 10000);
      } catch {}

      if (originalMessageId) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, originalMessageId);
        } catch {}
      }

      logger.info(`Spotify playlist "${entity.title}" completed (${completedCount} sent, ${failedCount} failed)`);
    }, { ctx, statusMessageId, originalMessageId });
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
}

module.exports = SpotifyStrategy;
