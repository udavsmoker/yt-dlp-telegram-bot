const path = require('path');
const fs = require('fs').promises;
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const config = require('../config');
const undoService = require('../services/undo.service');
const { getTelegramFileLocalPath } = require('./download/common/local-storage');
const logger = require('../utils/logger');
const { cleanupFile, generateFilename, generateThumbnailFromVideo, getFileForTelegram, getUserInfo, escapeHtml } = require('../utils/helpers');

/**
 * Parse human timestamp format (HH:MM:SS, MM:SS, or SS) to float seconds.
 * @param {string} str
 * @returns {number|null}
 */
function parseTimestamp(str) {
  if (!str || typeof str !== 'string') return null;
  const clean = str.trim();
  if (!clean) return null;

  // Format HH:MM:SS or MM:SS
  if (clean.includes(':')) {
    const parts = clean.split(':').map(p => parseFloat(p));
    if (parts.some(p => isNaN(p) || p < 0)) return null;

    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return null;
  }

  // Plain seconds number
  const num = parseFloat(clean);
  return (!isNaN(num) && num >= 0) ? num : null;
}

/**
 * Handle /cut command: trim video, audio, or voice note to a specific time range.
 * @param {object} ctx - Telegraf context
 */
async function handleCutCommand(ctx) {
  const userInfo = getUserInfo(ctx);
  const rawText = ctx.message?.text || '';
  const args = rawText.replace(/^\/cut(?:@\w+)?\s*/i, '').trim().split(/\s+/).filter(Boolean);

  const replyMsg = ctx.message?.reply_to_message;
  const targetMedia = replyMsg?.video || replyMsg?.audio || replyMsg?.voice || replyMsg?.video_note;

  if (!replyMsg || !targetMedia || args.length === 0) {
    return ctx.reply(
      '✂️ <b>Нарезка медиа (видео и аудио)</b>\n\n' +
      '<b>Как использовать:</b>\n' +
      'Ответьте на любое видео или аудио сообщением:\n' +
      '• <code>/cut 00:15 01:30</code> — обрезать от 0:15 до 1:30\n' +
      '• <code>/cut 10 45</code> — обрезать от 10-й до 45-й секунды\n' +
      '• <code>/cut 00:30</code> — обрезать от 0:30 до конца файла',
      { parse_mode: 'HTML' }
    );
  }

  const startTime = parseTimestamp(args[0]);
  const endTime = args.length > 1 ? parseTimestamp(args[1]) : null;

  if (startTime === null || (args.length > 1 && endTime === null)) {
    return ctx.reply('⚠️ Неверный формат времени. Используйте секунды (<code>15</code>) или минуты (<code>01:30</code>).', { parse_mode: 'HTML' });
  }

  if (endTime !== null && endTime <= startTime) {
    return ctx.reply('⚠️ Время окончания должно быть больше времени начала.', { parse_mode: 'HTML' });
  }

  let mediaType = 'video';
  let defaultExt = 'mp4';
  if (replyMsg.audio) {
    mediaType = 'audio';
    defaultExt = 'mp3';
  } else if (replyMsg.voice) {
    mediaType = 'voice';
    defaultExt = 'ogg';
  } else if (replyMsg.video_note) {
    mediaType = 'video_note';
    defaultExt = 'mp4';
  }

  const statusMessage = await ctx.reply('✂️ Нарезаю фрагмент...');
  logger.info(`Cutting ${mediaType} from ${startTime}s to ${endTime ? `${endTime}s` : 'end'} for ${userInfo}`);

  let localSource = null;
  let outputPath = null;
  let thumbPath = null;

  try {
    localSource = await getTelegramFileLocalPath(ctx, targetMedia.file_id, defaultExt);
    const outputFilename = generateFilename(`cut_${mediaType}`, defaultExt);
    outputPath = path.join(config.download.tempDir, outputFilename);

    const ffmpegArgs = ['-y'];

    if (startTime > 0) {
      ffmpegArgs.push('-ss', String(startTime));
    }

    if (endTime !== null) {
      ffmpegArgs.push('-to', String(endTime));
    }

    ffmpegArgs.push('-i', localSource.localPath);

    if (mediaType === 'audio' || mediaType === 'voice') {
      // Audio stream copy is instantaneous and lossless
      ffmpegArgs.push('-c', 'copy');
    } else {
      // Re-encode video with fast preset for exact frame boundary
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart'
      );
    }

    ffmpegArgs.push(outputPath);

    await execFile('ffmpeg', ffmpegArgs, { timeout: 180000 });

    // Verify file creation
    const stats = await fs.stat(outputPath);
    if (stats.size === 0) throw new Error('Cut file is empty');

    // Probe duration
    let duration = 0;
    try {
      const { stdout: probe } = await execFile('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'json',
        outputPath
      ], { encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(probe);
      duration = Math.ceil(parseFloat(parsed.format?.duration) || 0);
    } catch {}

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});

    let sent = null;
    const replyToId = replyMsg.message_id;

    if (mediaType === 'video' || mediaType === 'video_note') {
      thumbPath = await generateThumbnailFromVideo(outputPath);
      sent = await ctx.replyWithVideo(getFileForTelegram(outputPath), {
        duration: duration || undefined,
        width: targetMedia.width || undefined,
        height: targetMedia.height || undefined,
        thumbnail: thumbPath ? getFileForTelegram(thumbPath) : undefined,
        caption: `✂️ Фрагмент: ${args[0]} – ${args[1] || 'конец'}`,
        reply_to_message_id: replyToId
      });
    } else if (mediaType === 'audio') {
      sent = await ctx.replyWithAudio(getFileForTelegram(outputPath), {
        title: targetMedia.title ? `${targetMedia.title} (Cut)` : 'Audio Cut',
        performer: targetMedia.performer || undefined,
        duration: duration || undefined,
        caption: `✂️ Фрагмент: ${args[0]} – ${args[1] || 'конец'}`,
        reply_to_message_id: replyToId
      });
    } else if (mediaType === 'voice') {
      sent = await ctx.replyWithVoice(getFileForTelegram(outputPath), {
        duration: duration || undefined,
        caption: `✂️ Фрагмент: ${args[0]} – ${args[1] || 'конец'}`,
        reply_to_message_id: replyToId
      });
    }

    if (sent && ctx.chat?.id) {
      undoService.record(ctx.chat.id, [sent.message_id], ctx.from?.id);
    }

    logger.info(`Cut ${mediaType} sent successfully to ${userInfo}`);
  } catch (err) {
    logger.error(`Cut command failed for ${userInfo}: ${err.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ Ошибка нарезки: ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    ).catch(() => ctx.reply(`❌ Ошибка нарезки: ${err.message}`));
  } finally {
    if (localSource?.needsCleanup && localSource.localPath) {
      await cleanupFile(localSource.localPath);
    }
    if (thumbPath) {
      await cleanupFile(thumbPath);
    }
    if (outputPath) {
      await cleanupFile(outputPath);
    }
  }
}

module.exports = { handleCutCommand, parseTimestamp };
