const ttsService = require('../services/tts.service');
const undoService = require('../services/undo.service');
const logger = require('../utils/logger');
const { cleanupFile, getFileForTelegram, getUserInfo } = require('../utils/helpers');

/**
 * Handle /tts command: convert text or replied message text to a Telegram voice note.
 * @param {object} ctx - Telegraf context
 */
async function handleTts(ctx) {
  const userInfo = getUserInfo(ctx);
  let text = '';

  const rawMessage = ctx.message?.text || '';
  const match = rawMessage.match(/^\/tts(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (match && match[1]) {
    text = match[1].trim();
  }

  // If no direct text, check if replied to a message with text or caption
  if (!text && ctx.message?.reply_to_message) {
    const reply = ctx.message.reply_to_message;
    text = (reply.text || reply.caption || '').trim();
  }

  if (!text) {
    return ctx.reply(
      '🗣 <b>Озвучка текста в голос (TTS)</b>\n\n' +
      'Использование:\n' +
      '• <code>/tts Привет, как дела?</code>\n' +
      '• Или ответьте командой <code>/tts</code> на любое текстовое сообщение в чате.',
      { parse_mode: 'HTML' }
    );
  }

  logger.info(`TTS request from ${userInfo}: "${text.substring(0, 40)}..."`);
  let voiceResult = null;

  try {
    await ctx.sendChatAction('record_voice');

    voiceResult = await ttsService.synthesizeToOggOpus(text);

    const replyToId = ctx.message.reply_to_message?.message_id || ctx.message.message_id;
    const sent = await ctx.replyWithVoice(getFileForTelegram(voiceResult.filePath), {
      duration: voiceResult.duration || undefined,
      reply_to_message_id: replyToId
    });

    if (sent && ctx.chat?.id) {
      undoService.record(ctx.chat.id, [sent.message_id], ctx.from?.id);
    }
  } catch (err) {
    logger.error(`TTS synthesis failed for ${userInfo}: ${err.message}`);
    await ctx.reply(`❌ Ошибка озвучки: ${err.message}`);
  } finally {
    if (voiceResult?.filePath) {
      await cleanupFile(voiceResult.filePath);
    }
  }
}

module.exports = { handleTts };
