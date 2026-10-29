const audioService = require('../services/audio.service');
const undoService = require('../services/undo.service');
const { getTelegramFileLocalPath } = require('./download/common/local-storage');
const logger = require('../utils/logger');
const { cleanupFile, getFileForTelegram, getUserInfo, escapeHtml } = require('../utils/helpers');

/**
 * Parse title and artist from raw string.
 * Supports separators: " - ", " — ", " – ", " | ", " / "
 * @param {string} text
 * @returns {{ title: string|null, artist: string|null }}
 */
function parseTagText(text) {
  if (!text || typeof text !== 'string') return { title: null, artist: null };
  const clean = text.trim();
  if (!clean) return { title: null, artist: null };

  const match = clean.match(/^(.+?)\s*(?:[-—–|/])\s*(.+)$/);
  if (match) {
    return { title: match[1].trim(), artist: match[2].trim() };
  }

  return { title: clean, artist: null };
}

/**
 * Handle /tag, /retag, /cover commands to edit MP3 tags and cover art.
 * @param {object} ctx - Telegraf context
 */
async function handleTagCommand(ctx) {
  const userInfo = getUserInfo(ctx);
  const rawText = ctx.message?.text || ctx.message?.caption || '';
  const isCoverOnly = /^\/cover(?:@\w+)?/i.test(rawText);

  // Extract argument after command
  let tagArg = rawText.replace(/^\/(?:tag|retag|cover|edit)(?:@\w+)?\s*/i, '').trim();

  // Find target audio and optional cover photo
  let audioFileId = null;
  let audioDuration = null;
  let audioPerformer = null;
  let audioTitle = null;
  let photoFileId = null;

  // 1. Check if the current message is a photo sent as reply to audio
  if (ctx.message?.photo && ctx.message.reply_to_message?.audio) {
    const photoArr = ctx.message.photo;
    photoFileId = photoArr[photoArr.length - 1].file_id;
    const targetAudio = ctx.message.reply_to_message.audio;
    audioFileId = targetAudio.file_id;
    audioDuration = targetAudio.duration;
    audioPerformer = targetAudio.performer;
    audioTitle = targetAudio.title;
  }
  // 2. Check if replying to an audio message directly
  else if (ctx.message?.reply_to_message?.audio) {
    const targetAudio = ctx.message.reply_to_message.audio;
    audioFileId = targetAudio.file_id;
    audioDuration = targetAudio.duration;
    audioPerformer = targetAudio.performer;
    audioTitle = targetAudio.title;
  }
  // 3. Check if replying to a photo (and user sent audio previously or vice versa)
  else if (ctx.message?.reply_to_message?.photo) {
    const photoArr = ctx.message.reply_to_message.photo;
    photoFileId = photoArr[photoArr.length - 1].file_id;
  }

  if (!audioFileId) {
    return ctx.reply(
      '🏷 <b>Редактирование тегов и обложки аудио</b>\n\n' +
      '<b>Как использовать:</b>\n' +
      '• Ответьте на трек: <code>/tag Название - Исполнитель</code>\n' +
      '• Сменить обложку: отправьте фото в ответ на аудио с подписью <code>/cover</code>\n' +
      '• Сменить всё сразу: отправьте фото в ответ на аудио с подписью <code>/tag Название - Исполнитель</code>',
      { parse_mode: 'HTML' }
    );
  }

  if (isCoverOnly && !photoFileId) {
    return ctx.reply(
      '🖼 <b>Смена обложки</b>\n\n' +
      'Чтобы поставить новую обложку, отправьте картинку в ответ на трек с подписью <code>/cover</code>.',
      { parse_mode: 'HTML' }
    );
  }

  if (!isCoverOnly && !tagArg && !photoFileId) {
    return ctx.reply(
      '💡 Укажите новые теги, например:\n<code>/tag Bohemian Rhapsody - Queen</code>',
      { parse_mode: 'HTML' }
    );
  }

  const { title: parsedTitle, artist: parsedArtist } = parseTagText(tagArg);
  const finalTitle = parsedTitle || audioTitle || 'Audio';
  const finalArtist = parsedArtist || audioPerformer || 'Unknown';

  logger.info(`Editing audio tags for ${userInfo}: "${finalTitle}" by "${finalArtist}" (cover: ${Boolean(photoFileId)})`);
  const statusMessage = await ctx.reply('🎨 Обновляю теги и обложку...');

  let audioLocal = null;
  let coverLocal = null;
  let result = null;

  try {
    audioLocal = await getTelegramFileLocalPath(ctx, audioFileId, 'mp3');
    if (photoFileId) {
      coverLocal = await getTelegramFileLocalPath(ctx, photoFileId, 'jpg');
    }

    result = await audioService.editAudioTags(audioLocal.localPath, {
      title: finalTitle,
      artist: finalArtist,
      album: finalTitle,
      coverPath: coverLocal ? coverLocal.localPath : null
    });

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});

    const audioOptions = {
      title: result.title,
      performer: result.artist,
      duration: result.duration || audioDuration || undefined,
      reply_to_message_id: ctx.message.reply_to_message?.message_id || ctx.message.message_id
    };

    if (coverLocal) {
      audioOptions.thumbnail = getFileForTelegram(coverLocal.localPath);
    }

    const sent = await ctx.replyWithAudio(getFileForTelegram(result.audioPath), audioOptions);

    if (sent && ctx.chat?.id) {
      undoService.record(ctx.chat.id, [sent.message_id], ctx.from?.id);
    }

    logger.info(`Audio retagged and sent successfully to ${userInfo}`);
  } catch (err) {
    logger.error(`Failed to edit audio tags for ${userInfo}: ${err.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ Ошибка при изменении тегов: ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    ).catch(() => ctx.reply(`❌ Ошибка: ${err.message}`));
  } finally {
    if (audioLocal?.needsCleanup && audioLocal.localPath) {
      await cleanupFile(audioLocal.localPath);
    }
    if (coverLocal?.needsCleanup && coverLocal.localPath) {
      await cleanupFile(coverLocal.localPath);
    }
    if (result?.audioPath) {
      await cleanupFile(result.audioPath);
    }
  }
}

module.exports = { handleTagCommand, parseTagText };
