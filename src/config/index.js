require('dotenv').config();

module.exports = {
  botToken: process.env.BOT_TOKEN,
  botApiUrl: process.env.BOT_API_URL,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',
  webhook: {
    domain: process.env.WEBHOOK_DOMAIN,
    port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
    path: process.env.WEBHOOK_PATH || '/telegram-webhook'
  },
  download: {
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE || '50', 10),
    tempDir: process.env.TEMP_DIR || './temp',
    cookiesFile: process.env.YTDLP_COOKIES_FILE || (require('fs').existsSync(require('path').join(__dirname, '../../cookies.txt')) ? require('path').join(__dirname, '../../cookies.txt') : null)
  },
  adminUserId: parseInt(process.env.ADMIN_USER_ID || '0', 10),
  cache: {
    enabled: process.env.ENABLE_VIDEO_CACHE !== 'false',
    ttlHours: parseInt(process.env.CACHE_TTL_HOURS || '48', 10)
  },
  queue: {
    concurrency: parseInt(process.env.DOWNLOAD_CONCURRENCY || '4', 10)
  },
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '30', 10),
    downloadMaxRequests: parseInt(process.env.DOWNLOAD_RATE_LIMIT_MAX || '5', 10)
  }
};


