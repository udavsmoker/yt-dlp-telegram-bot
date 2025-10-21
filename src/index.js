const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const config = require('./config');
const logger = require('./utils/logger');
const { loggingMiddleware, errorHandler, rateLimiter } = require('./middleware');
const { markovLearningMiddleware, markovResponseHandler } = require('./middleware/markov.middleware');
const { photoLearningMiddleware } = require('./middleware/photo.middleware');
const handleStart = require('./handlers/start.handler');
const handleHelp = require('./handlers/help.handler');
const handleAbout = require('./handlers/about.handler');
const handleDownload = require('./handlers/download.handler');
const handleMeme = require('./handlers/meme.handler');
const { handleDemotivate, handlePhotoStats } = require('./handlers/demotivator.handler');
const { handleSettings, handleSettingsCallback } = require('./handlers/settings.handler');
const { handleSetLaziness, handleSetCoherence, handleSetSassiness, handleBotStats } = require('./handlers/markov.handler');
const settingsService = require('./services/settings.service');
const memeService = require('./services/meme.service');
const demotivatorService = require('./services/demotivator.service');
const photoDb = require('./services/photo-database.service');
const { ensureDir } = require('./utils/helpers');

if (!config.botToken) {
  logger.error('BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

const bot = new Telegraf(config.botToken);

bot.use(errorHandler());
bot.use(loggingMiddleware());

bot.use(markovLearningMiddleware);
bot.use(photoLearningMiddleware);

bot.command('start', handleStart);
bot.command('help', handleHelp);
bot.command('about', handleAbout);

bot.command('meme', handleMeme);

bot.command('demotivate', handleDemotivate);
bot.command('photostats', handlePhotoStats);

bot.command('settings', handleSettings);

bot.command('setlaziness', handleSetLaziness);
bot.command('setcoherence', handleSetCoherence);
bot.command('setsassiness', handleSetSassiness);
bot.command('botstats', handleBotStats);

bot.action(/^toggle_/, handleSettingsCallback);
bot.action('settings_close', handleSettingsCallback);

bot.on(message('text'), handleDownload);

bot.use(markovResponseHandler);

bot.catch((err, ctx) => {
  logger.error('Bot error:', err);
});

const shutdown = async (signal) => {
  logger.info(`Received ${signal}, shutting down...`);
  try {
    await bot.stop(signal);
    logger.info('Bot stopped successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function startBot() {
  try {
    await ensureDir(config.download.tempDir);
    await ensureDir('./logs');
    await ensureDir('./data');
    await ensureDir('./templates');
    
    await settingsService.init();
    await memeService.init();
    await demotivatorService.init();
    photoDb.init();
    
    logger.info('Starting bot...');
    logger.info('Using yt-dlp for video downloads');
    
    if (config.webhook.domain) {
      await bot.launch({
        webhook: {
          domain: config.webhook.domain,
          port: config.webhook.port,
          path: config.webhook.path
        }
      });
      logger.info(`Bot started in webhook mode on ${config.webhook.domain}${config.webhook.path}`);
    } else {
      await bot.launch({
        dropPendingUpdates: true
      });
      logger.info('Bot started in polling mode (pending updates dropped)');
    }
    
    const botInfo = await bot.telegram.getMe();
    logger.info(`Bot @${botInfo.username} is running`);
    logger.info('Supports 1000+ platforms via yt-dlp');
    
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

startBot();
