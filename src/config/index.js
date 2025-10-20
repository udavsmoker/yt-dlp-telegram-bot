require('dotenv').config();

module.exports = {
  botToken: process.env.BOT_TOKEN,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',
  webhook: {
    domain: process.env.WEBHOOK_DOMAIN,
    port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
    path: process.env.WEBHOOK_PATH || '/telegram-webhook'
  },
  download: {
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE || '50', 10),
    tempDir: process.env.TEMP_DIR || './temp'
  }
};
