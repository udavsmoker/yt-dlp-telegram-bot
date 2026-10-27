const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const config = require('../../../config');
const audioService = require('../../../services/audio.service');
const logger = require('../../../utils/logger');
const { cleanupFile, generateFilename, getFileForTelegram, getUserInfo } = require('../../../utils/helpers');
const { getVideoLocalPath } = require('../common/local-storage');
const { getSenderInfo } = require('../common/telegram-sender');

const pendingAudioExtracts = new Map();

/**
 * Register pending audio extract for inline YouTube audio button.
 * @param {number} messageId
 * @param {object} data
 */
function registerPendingAudioExtract(messageId, data) {
  pendingAudioExtracts.set(messageId, data);
  setTimeout(() => pendingAudioExtracts.delete(messageId), 600000);
}

/**
 * Handle /mp3 command (reply to a video message).
 * @param {object} ctx - Telegraf context
 */
async function handleMp3Command(ctx) {
  const replyMessage = ctx.message?.reply_to_message;

  if (!replyMessage) {
    await ctx.reply('💡 Reply to a video message with /mp3 to extract audio.');
    return;
  }

  const video = replyMessage.video;
  if (!video) {
    await ctx.reply('⚠️ The replied message does not contain a video.');
    return;
  }

  let title = 'Audio';
  let author = 'Unknown';

  if (replyMessage.caption) {
    const titleMatch = replyMessage.caption.match(/🎬\s+([^\n]+)/);
    if (titleMatch) title = titleMatch[1].trim();

    const authorMatch = replyMessage.caption.match(/👤\s+([^\n]+)/);
    if (authorMatch) author = authorMatch[1].trim();
  }

  const thumbnailFileId = video.thumbnail?.file_id || video.thumb?.file_id;
  const userInfo = getUserInfo(ctx);
  logger.info(`MP3 extraction requested by ${userInfo}`);

  const statusMessage = await ctx.reply('🎵 Extracting audio...');

  let videoPath = null;
  let audioResult = null;
  let thumbPath = null;

  try {
    const videoFile = await getVideoLocalPath(ctx, video.file_id);
    if (videoFile.needsCleanup) videoPath = videoFile.localPath;

    if (thumbnailFileId) {
      try {
        const thumbFile = await ctx.telegram.getFile(thumbnailFileId);
        thumbPath = path.join(config.download.tempDir, generateFilename('audio_thumb', 'jpg'));

        if (thumbFile.file_path && thumbFile.file_path.startsWith('/')) {
          await fs.copyFile(thumbFile.file_path, thumbPath);
        } else {
          const thumbLink = await ctx.telegram.getFileLink(thumbnailFileId);
          const thumbRes = await axios.get(thumbLink.href, { responseType: 'arraybuffer' });
          await fs.writeFile(thumbPath, thumbRes.data);
        }
      } catch (err) {
        logger.warn(`Failed to download thumbnail for audio: ${err.message}`);
        thumbPath = null;
      }
    }

    audioResult = await audioService.convertToMp3(videoFile.localPath, thumbPath);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading audio...'
    );

    const audioOptions = {
      title: (title !== 'Audio' ? title : null) || (audioResult.title !== 'Audio' ? audioResult.title : undefined),
      performer: (author !== 'Unknown' ? author : null) || (audioResult.artist !== 'Unknown' ? audioResult.artist : undefined),
      duration: audioResult.duration || undefined,
      reply_to_message_id: replyMessage.message_id
    };

    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    if (isGroup) {
      const sender = getSenderInfo(ctx);
      audioOptions.caption = `Sent by ${sender.caption}`;
      audioOptions.parse_mode = 'HTML';
    }

    if (thumbPath) {
      audioOptions.thumbnail = getFileForTelegram(thumbPath);
    }

    const sentAudio = await ctx.replyWithAudio(
      getFileForTelegram(audioResult.audioPath),
      audioOptions
    );

    if (sentAudio && ctx.chat?.id) {
      const undoService = require('../../../services/undo.service');
      undoService.record(ctx.chat.id, [sentAudio.message_id], ctx.from?.id);
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
    logger.info(`MP3 sent successfully to ${userInfo}`);
  } catch (error) {
    logger.error(`MP3 extraction failed for ${userInfo}: ${error.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ Audio extraction failed: ${error.message}`
    );
  } finally {
    if (videoPath) await cleanupFile(videoPath);
    if (audioResult?.audioPath) await cleanupFile(audioResult.audioPath);
    if (thumbPath) await cleanupFile(thumbPath);
  }
}

/**
 * Handle 'yt_audio' callback query under sent YouTube videos.
 * @param {object} ctx - Telegraf context
 */
async function handleAudioCallback(ctx) {
  const messageId = ctx.callbackQuery.message.message_id;
  const userId = ctx.from?.id;

  const pending = pendingAudioExtracts.get(messageId);

  if (!pending) {
    const videoMsg = ctx.callbackQuery.message;
    if (!videoMsg?.video) {
      await ctx.answerCbQuery('⚠️ This request has expired.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('🎵 Extracting audio...');
    await processAudioExtraction(ctx, videoMsg.video.file_id, userId, null, null);
    return;
  }

  await ctx.answerCbQuery('🎵 Extracting audio...');

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch {}

  await processAudioExtraction(ctx, pending.videoFileId, userId, pending.title, pending.author, pending.thumbnailFileId);
}

/**
 * Extract audio from a video Telegram file_id and send as MP3.
 * @param {object} ctx
 * @param {string} videoFileId
 * @param {number} userId
 * @param {string|null} title
 * @param {string|null} author
 * @param {string|null} thumbnailFileId
 */
async function processAudioExtraction(ctx, videoFileId, userId, title, author, thumbnailFileId) {
  const userInfo = getUserInfo(ctx);
  const statusMessage = await ctx.reply('🎵 Extracting audio...');

  let videoPath = null;
  let audioResult = null;
  let thumbPath = null;

  try {
    const videoFile = await getVideoLocalPath(ctx, videoFileId);
    if (videoFile.needsCleanup) videoPath = videoFile.localPath;

    if (thumbnailFileId) {
      try {
        const thumbFile = await ctx.telegram.getFile(thumbnailFileId);
        thumbPath = path.join(config.download.tempDir, generateFilename('audio_thumb', 'jpg'));

        if (thumbFile.file_path && thumbFile.file_path.startsWith('/')) {
          await fs.copyFile(thumbFile.file_path, thumbPath);
        } else {
          const thumbLink = await ctx.telegram.getFileLink(thumbnailFileId);
          const thumbRes = await axios.get(thumbLink.href, { responseType: 'arraybuffer' });
          await fs.writeFile(thumbPath, thumbRes.data);
        }
      } catch (err) {
        logger.warn(`Failed to download thumbnail for audio: ${err.message}`);
        thumbPath = null;
      }
    }

    audioResult = await audioService.convertToMp3(videoFile.localPath, thumbPath);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading audio...'
    );

    const audioOptions = {
      title: title || (audioResult.title !== 'Audio' ? audioResult.title : undefined),
      performer: author || (audioResult.artist !== 'Unknown' ? audioResult.artist : undefined),
      duration: audioResult.duration || undefined
    };

    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    if (isGroup) {
      const sender = getSenderInfo(ctx);
      audioOptions.caption = `Sent by ${sender.caption}`;
      audioOptions.parse_mode = 'HTML';
    }

    if (thumbPath) {
      audioOptions.thumbnail = getFileForTelegram(thumbPath);
    }

    const sentAudio = await ctx.replyWithAudio(
      getFileForTelegram(audioResult.audioPath),
      audioOptions
    );

    if (sentAudio && ctx.chat?.id) {
      const undoService = require('../../../services/undo.service');
      undoService.record(ctx.chat.id, [sentAudio.message_id], ctx.from?.id);
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
    logger.info(`Audio extracted and sent successfully to ${userInfo}`);
  } catch (error) {
    logger.error(`Audio extraction failed for ${userInfo}: ${error.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ Audio extraction failed: ${error.message}`
    );
  } finally {
    if (videoPath) await cleanupFile(videoPath);
    if (audioResult?.audioPath) await cleanupFile(audioResult.audioPath);
    if (thumbPath) await cleanupFile(thumbPath);
  }
}

module.exports = {
  handleMp3Command,
  handleAudioCallback,
  registerPendingAudioExtract,
  processAudioExtraction
};
