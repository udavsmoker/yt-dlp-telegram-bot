const markovDb = require('../services/markov-database.service');
const markovService = require('../services/markov.service');
const settingsService = require('../services/settings.service');
const photoDb = require('../services/photo-database.service');
const demotivatorService = require('../services/demotivator.service');
const ttsService = require('../services/tts.service');
const undoService = require('../services/undo.service');
const { getFileForTelegram, cleanupFile } = require('../utils/helpers');
const logger = require('../utils/logger');

async function markovLearningMiddleware(ctx, next) {
  try {
    if (!ctx.message || !ctx.message.text || !ctx.from) {
      return next();
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const messageText = ctx.message.text;
    const replyToMessageId = ctx.message.reply_to_message?.message_id || null;

    if (messageText.startsWith('/')) {
      return next();
    }

    const isEnabled = await settingsService.isFeatureEnabled(chatId, 'markovResponses');
    if (!isEnabled) {
      return next();
    }

    markovDb.saveMessage(chatId, userId, messageText, replyToMessageId);
    logger.debug(`Saved message from user ${userId} in chat ${chatId}`);

    return next();
  } catch (error) {
    logger.error(`Error in markov learning middleware: ${error.message}`);
    return next();
  }
}

async function markovResponseHandler(ctx, next) {
  try {
    if (!ctx.message || !ctx.message.text || !ctx.from) {
      return next();
    }

    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    
    if (chatType !== 'group' && chatType !== 'supergroup') {
      return next();
    }

    const isEnabled = await settingsService.isFeatureEnabled(chatId, 'markovResponses');
    if (!isEnabled) {
      return next();
    }

    const messageText = ctx.message.text;
    const fromUserId = ctx.from.id;
    const botUserId = ctx.botInfo.id;

    if (messageText.startsWith('/')) {
      return next();
    }

    const shouldRespond = markovService.shouldRespond(chatId, messageText, fromUserId, botUserId);
    
    if (!shouldRespond) {
      return next();
    }

    logger.info(`Generating Markov response for chat ${chatId}`);
    
    const delay = 1500 + Math.random() * 4000;
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    const response = await markovService.generateResponse(chatId, messageText, botUserId);
    
    if (response) {
      const roll = Math.random();
      const demotivatorsEnabled = await settingsService.isFeatureEnabled(chatId, 'demotivatorsEnabled');
      const photoCount = photoDb.getPhotoCount(chatId);

      // 1. Chance to send a generated demotivator with Markov text and a random chat photo (~15%)
      if (demotivatorsEnabled && photoCount > 0 && roll < 0.15) {
        let demotivateResult = null;
        try {
          logger.info(`Sending random Markov demotivator to chat ${chatId}`);
          await ctx.sendChatAction('upload_photo');
          demotivateResult = await demotivatorService.generateDemotivator(chatId, null, ctx.telegram, response);
          const sent = await ctx.replyWithPhoto(getFileForTelegram(demotivateResult.filePath));
          if (sent) {
            undoService.record(chatId, [sent.message_id], botUserId);
          }
          return next();
        } catch (demotivateErr) {
          logger.warn(`Failed to create Markov demotivator, falling back: ${demotivateErr.message}`);
        } finally {
          if (demotivateResult?.filePath) {
            await cleanupFile(demotivateResult.filePath);
          }
        }
      }

      // 2. Chance to voice the Markov message via TTS voice note (~20%)
      if (response.length <= 250 && roll >= 0.15 && roll < 0.35) {
        let voiceResult = null;
        try {
          logger.info(`Sending Markov TTS voice note to chat ${chatId}`);
          await ctx.sendChatAction('record_voice');
          voiceResult = await ttsService.synthesizeToOggOpus(response);
          const sent = await ctx.replyWithVoice(getFileForTelegram(voiceResult.filePath), {
            duration: voiceResult.duration || undefined
          });
          if (sent) {
            undoService.record(chatId, [sent.message_id], botUserId);
          }
          return next();
        } catch (voiceErr) {
          logger.warn(`Failed to synthesize Markov voice note, falling back to text: ${voiceErr.message}`);
        } finally {
          if (voiceResult?.filePath) {
            await cleanupFile(voiceResult.filePath);
          }
        }
      }

      // 3. Regular text response (~65-85%)
      await ctx.sendChatAction('typing');
      const sent = await ctx.reply(response);
      if (sent) {
        undoService.record(chatId, [sent.message_id], botUserId);
      }
      logger.info(`Sent Markov response to chat ${chatId}: "${response.substring(0, 50)}..."`);
    } else {
      logger.debug(`No response generated for chat ${chatId}`);
    }

    return next();
  } catch (error) {
    logger.error(`Error in markov response handler: ${error.message}`);
    return next();
  }
}

module.exports = {
  markovLearningMiddleware,
  markovResponseHandler
};
