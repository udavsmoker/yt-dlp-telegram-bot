const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

function loggingMiddleware() {
  return async (ctx, next) => {
    const start = Date.now();
    const userInfo = getUserInfo(ctx);
    const updateType = ctx.updateType;
    
    logger.info(`Received ${updateType} from ${userInfo}`);
    
    try {
      await next();
      const ms = Date.now() - start;
      logger.info(`Processed ${updateType} in ${ms}ms`);
    } catch (error) {
      const ms = Date.now() - start;
      logger.error(`Error processing ${updateType} after ${ms}ms:`, error);
      throw error;
    }
  };
}

function errorHandler() {
  return async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      logger.error('Error in bot:', error);
      
      const errorMessage = error.message || 'An unknown error occurred';
      
      try {
        await ctx.reply(
          `❌ Error: ${errorMessage}\n\nPlease try again or contact support if the problem persists.`,
          { parse_mode: 'Markdown' }
        );
      } catch (replyError) {
        logger.error('Failed to send error message:', replyError);
      }
    }
  };
}

module.exports = {
  loggingMiddleware,
  errorHandler
};
