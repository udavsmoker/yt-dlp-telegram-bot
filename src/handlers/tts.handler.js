const ttsService = require('../services/tts.service');
const undoService = require('../services/undo.service');
const logger = require('../utils/logger');
const { cleanupFile, getFileForTelegram, getUserInfo } = require('../utils/helpers');

const KNOWN_VOICES = ['demon', 'bass', 'chipmunk', 'anime', 'robot', 'radio', 'slow', 'fast', 'normal', 'default', 'random'];
const LANG_REGEX = /^[a-z]{2}(?:-[a-z]{2})?$/i;

/**
 * Parse TTS flags (-demon, -chipmunk, -robot, -radio, -slow, -fast, -random, -en, -ja, etc.) and text.
 * @param {string} raw
 * @returns {{ text: string, voice: string|null, lang: string|null }}
 */
function parseTtsArgs(raw) {
  if (!raw || typeof raw !== 'string') {
    return { text: '', voice: null, lang: null };
  }

  const parts = raw.trim().split(/\s+/);
  let voice = null;
  let lang = null;
  const remaining = [];

  for (const part of parts) {
    if (part.startsWith('-') || (part.startsWith('/') && part.length > 1 && !part.startsWith('/tts'))) {
      const flag = part.replace(/^[-/]+/, '').toLowerCase();
      if (KNOWN_VOICES.includes(flag)) {
        voice = flag;
        continue;
      }
      if (LANG_REGEX.test(flag) && flag.length <= 5) {
        lang = flag;
        continue;
      }
    }
    remaining.push(part);
  }

  return {
    text: remaining.join(' ').trim(),
    voice,
    lang
  };
}

/**
 * Handle /tts command: convert text or replied message text to a Telegram voice note.
 * @param {object} ctx - Telegraf context
 */
async function handleTts(ctx) {
  const userInfo = getUserInfo(ctx);

  const rawMessage = ctx.message?.text || '';
  const match = rawMessage.match(/^\/tts(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  const commandArg = match && match[1] ? match[1].trim() : '';

  let { text, voice, lang } = parseTtsArgs(commandArg);

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
      '• Или ответьте <code>/tts</code> на любое текстовое сообщение.\n\n' +
      '<b>Флаги голоса (для теста):</b>\n' +
      '• <code>-demon</code> — бас / демон 👹\n' +
      '• <code>-chipmunk</code> — бурундук / аниме 🐿\n' +
      '• <code>-robot</code> — металлический киборг 🤖\n' +
      '• <code>-radio</code> — эффект рации / мегафона 📻\n' +
      '• <code>-slow</code> — замедленный 🐌\n' +
      '• <code>-fast</code> — ускоренный ⚡\n' +
      '• <code>-random</code> — случайный голос 🎲\n' +
      '• <code>-en</code>, <code>-ja</code>, <code>-de</code> — сменить язык 🌍\n\n' +
      '<i>Пример: <code>/tts -demon Восстание машин началось</code></i>',
      { parse_mode: 'HTML' }
    );
  }

  if (voice === 'random') {
    voice = ttsService.getRandomVoice();
  }

  logger.info(`TTS request from ${userInfo} (voice=${voice || 'normal'}, lang=${lang || 'ru'}): "${text.substring(0, 40)}..."`);
  let voiceResult = null;

  try {
    await ctx.sendChatAction('record_voice');

    voiceResult = await ttsService.synthesizeToOggOpus(text, {
      voice: voice || 'normal',
      lang: lang || 'ru'
    });

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

module.exports = { handleTts, parseTtsArgs };
