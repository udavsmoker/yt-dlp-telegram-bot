const blacklistService = require('../services/blacklist.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');

function safeUserInfo(ctx) {
  try {
    if (!ctx || !ctx.from) return 'Unknown user';
    const user = ctx.from;
    return `@${user.username || 'unknown'} (${user.id})`;
  } catch {
    return 'Unknown user';
  }
}

/**
 * Middleware to check if user is blacklisted before command execution
 * Returns random offensive response if blacklisted
 */
function blacklistCheckMiddleware() {
  return async (ctx, next) => {
    try {
      // Only check for command messages (start with /)
      if (!ctx.message?.text || !ctx.message.text.startsWith('/')) {
        return next();
      }

      // Allow /blacklist command for admin to manage blacklist
      if (ctx.message.text.startsWith('/blacklist')) {
        return next();
      }

      const userId = ctx.from.id;
      const chatId = ctx.chat.id;

      // Check if blacklist feature is enabled for this chat
      const isEnabled = settingsService.isFeatureEnabled(chatId, 'blacklistEnabled');
      if (!isEnabled) {
        return next();
      }

      // Check if user is blacklisted
      if (blacklistService.isBlacklisted(userId)) {
        const response = blacklistService.getRandomResponse();
        await ctx.reply(response);

        logger.warn(`Blocked command from blacklisted user ${safeUserInfo(ctx)}: ${ctx.message.text}`);

        // Stop execution - don't call next()
        return;
      }

      // User not blacklisted, continue to command handler
      return next();
    } catch (error) {
      logger.error('Error in blacklist middleware:', error);
      // On error, allow command to proceed (fail open)
      return next();
    }
  };
}

module.exports = {
  blacklistCheckMiddleware
};
