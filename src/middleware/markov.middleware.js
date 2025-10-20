const markovDb = require('../services/markov-database.service');
const markovService = require('../services/markov.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');

async function markovLearningMiddleware(ctx, next) {
  try {
    if (!ctx.message || !ctx.message.text) {
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
    if (!ctx.message || !ctx.message.text) {
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
    
    const delay = 2000 + Math.random() * 6000;
    
    await ctx.sendChatAction('typing');
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    const response = await markovService.generateResponse(chatId, messageText, botUserId);
    
    if (response) {
      await ctx.reply(response);
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
