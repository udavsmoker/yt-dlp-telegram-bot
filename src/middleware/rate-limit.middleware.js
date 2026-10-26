const config = require('../config');
const logger = require('../utils/logger');

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000;
    this.max = options.max || 30;
    this.store = new Map();

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.store.entries()) {
      const recent = timestamps.filter(t => now - t < this.windowMs);
      if (recent.length === 0) {
        this.store.delete(key);
      } else {
        this.store.set(key, recent);
      }
    }
  }

  check(key, customMax = null, customWindowMs = null) {
    const windowMs = customWindowMs || this.windowMs;
    const max = customMax || this.max;
    const now = Date.now();
    const timestamps = this.store.get(key) || [];
    const recent = timestamps.filter(t => now - t < windowMs);

    if (recent.length >= max) {
      const oldest = recent[0];
      const retryAfterMs = Math.max(0, windowMs - (now - oldest));
      return { limited: true, retryAfterMs };
    }

    recent.push(now);
    this.store.set(key, recent);
    return { limited: false, retryAfterMs: 0 };
  }
}

const globalLimiter = new RateLimiter({
  windowMs: config.rateLimit?.windowMs || 60000,
  max: config.rateLimit?.maxRequests || 30
});

const downloadLimiter = new RateLimiter({
  windowMs: 60000,
  max: config.rateLimit?.downloadMaxRequests || 5
});

/**
 * Global rate limiting middleware for Telegraf.
 */
function rateLimitMiddleware() {
  return async (ctx, next) => {
    if (config.rateLimit?.enabled === false) {
      return next();
    }

    // Exclude channel posts and admin user
    if (ctx.chat?.type === 'channel') {
      return next();
    }
    const userId = ctx.from?.id;
    if (!userId) {
      return next();
    }
    if (config.adminUserId && userId === config.adminUserId) {
      return next();
    }

    const result = globalLimiter.check(String(userId));
    if (result.limited) {
      logger.warn(`Global rate limit reached for user ${userId}`);
      try {
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery('⚠️ Too many requests. Please wait a moment.', { show_alert: true });
        } else if (ctx.message) {
          await ctx.reply('⚠️ You are sending requests too quickly. Please wait a moment.');
        }
      } catch {}
      return;
    }

    return next();
  };
}

module.exports = {
  RateLimiter,
  rateLimitMiddleware,
  globalLimiter,
  downloadLimiter
};
