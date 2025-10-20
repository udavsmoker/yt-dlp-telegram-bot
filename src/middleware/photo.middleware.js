const photoDb = require('../services/photo-database.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function photoLearningMiddleware(ctx, next) {
  try {
    if (!ctx.chat) {
      return next();
    }

    const isEnabled = await settingsService.isFeatureEnabled(ctx.chat.id, 'demotivatorsEnabled');
    if (!isEnabled) {
      return next();
    }

    if (ctx.message && ctx.message.photo && ctx.message.photo.length > 0) {
      const userInfo = getUserInfo(ctx);
      const chatId = ctx.chat.id;
      const userId = ctx.from.id;
      const messageId = ctx.message.message_id;
      const caption = ctx.message.caption || null;

      photoDb.savePhoto(chatId, userId, ctx.message.photo, messageId, caption);

      const photoCount = photoDb.getPhotoCount(chatId);
      logger.info(`Photo learned from ${userInfo} in chat ${chatId}. Total photos: ${photoCount}`);
    }

    return next();
  } catch (error) {
    logger.error('Error in photo learning middleware:', error);
    return next();
  }
}

module.exports = { photoLearningMiddleware };
