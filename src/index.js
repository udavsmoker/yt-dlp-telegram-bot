const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const config = require('./config');
const logger = require('./utils/logger');
const { loggingMiddleware, errorHandler, rateLimitMiddleware } = require('./middleware');
const { markovLearningMiddleware, markovResponseHandler } = require('./middleware/markov.middleware');
const { photoLearningMiddleware } = require('./middleware/photo.middleware');
const { blacklistCheckMiddleware } = require('./middleware/blacklist.middleware');
const handleStart = require('./handlers/start.handler');
const handleHelp = require('./handlers/help.handler');
const handleAbout = require('./handlers/about.handler');
const { handleDownload, handleYouTubeCallback, handleInstagramCallback, handleSpotifyCallback, handleMp3Command, handleAudioCallback } = require('./handlers/download.handler');
const handleMeme = require('./handlers/meme.handler');
const { handleDemotivate, handlePhotoStats } = require('./handlers/demotivator.handler');
const { handleSettings, handleSettingsCallback } = require('./handlers/settings.handler');
const { handleSetLaziness, handleSetCoherence, handleSetSassiness, handleBotStats } = require('./handlers/markov.handler');
const { handleBlacklist } = require('./handlers/blacklist.handler');
const { handleHealth } = require('./handlers/health.handler');
const handleUndo = require('./handlers/undo.handler');
const handleCancel = require('./handlers/cancel.handler');
const { handleSearchCommand, handleSearchCallback } = require('./handlers/search.handler');
const { handleTts } = require('./handlers/tts.handler');
const { handleTagCommand } = require('./handlers/tag.handler');
const { handleCutCommand } = require('./handlers/cut.handler');
const { handleInlineQuery, handleChosenInlineResult, handleInlineDownloadCallback } = require('./handlers/inline.handler');
const settingsService = require('./services/settings.service');
const memeService = require('./services/meme.service');
const demotivatorService = require('./services/demotivator.service');
const photoDb = require('./services/photo-database.service');
const { ensureDir, startTempCleanup } = require('./utils/helpers');

if (!config.botToken) {
  logger.error('BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

const bot = new Telegraf(config.botToken, {
  handlerTimeout: 300000, // 5 minutes for slow downloads
  telegram: {
    apiRoot: config.botApiUrl || 'https://api.telegram.org'
  }
});

bot.use(errorHandler());

// Normalize channel_post updates so handlers can use ctx.message uniformly
bot.use((ctx, next) => {
  const post = ctx.channelPost || ctx.editedChannelPost;
  if (post) {
    if (!ctx.update.message) {
      ctx.update.message = post;
    }
    Object.defineProperty(ctx, 'message', {
      value: post,
      writable: true,
      configurable: true
    });
  }
  return next();
});

bot.use(loggingMiddleware());

// Blacklist check - must be before commands
bot.use(blacklistCheckMiddleware());

// Rate limit check - throttle spammers before heavy command handlers
bot.use(rateLimitMiddleware());

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

bot.command('blacklist', handleBlacklist);
bot.command('mp3', handleMp3Command);
bot.command('health', handleHealth);
bot.command('ping', handleHealth);
bot.command('undo', handleUndo);
bot.command('cancel', handleCancel);
bot.command(['music', 'song', 'track', 'find', 'search'], handleSearchCommand);
bot.command('tts', handleTts);
bot.command(['tag', 'retag', 'cover', 'edit'], handleTagCommand);
bot.command('cut', handleCutCommand);

bot.action(/^toggle_/, handleSettingsCallback);
bot.action('settings_close', handleSettingsCallback);

// YouTube download confirmation and quality selection callbacks
bot.action(['yt_download', 'yt_cancel', 'ytq_1080', 'ytq_720', 'ytq_480', 'ytq_audio', 'ytq_cancel'], handleYouTubeCallback);
bot.action('yt_audio', handleAudioCallback);

// Instagram carousel selection callbacks
bot.action('insta_single', handleInstagramCallback);
bot.action('insta_all', handleInstagramCallback);

// Spotify playlist/album confirmation callbacks
bot.action(['spot_download', 'spot_cancel'], handleSpotifyCallback);

// Song search selection and cancellation callbacks
bot.action(/^s_dl_/, handleSearchCallback);
bot.action(/^s_cancel_/, handleSearchCallback);

// Inline mode query and callback handlers
bot.on('inline_query', handleInlineQuery);
bot.on('chosen_inline_result', handleChosenInlineResult);
bot.action(/^inline_(?:dl|wait):/, handleInlineDownloadCallback);

bot.on(message('text'), handleDownload);
bot.on('channel_post', (ctx, next) => {
  if (ctx.channelPost && (ctx.channelPost.text || ctx.channelPost.caption)) {
    return handleDownload(ctx, next);
  }
  return next();
});

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
    startTempCleanup(config.download.tempDir);
    await ensureDir('./logs');
    await ensureDir('./data');
    await ensureDir('./templates');
    
    await settingsService.init();
    await memeService.init();
    await demotivatorService.init();
    photoDb.init();
    
    logger.info('Starting bot...');
    logger.info('Using yt-dlp for video downloads');
    
    if (config.botApiUrl) {
      logger.info(`Using local Bot API server: ${config.botApiUrl}`);
      logger.info(`Max file size: ${config.download.maxFileSizeMB}MB`);
    } else {
      logger.info('Using official Telegram Bot API');
      logger.info(`Max file size: ${config.download.maxFileSizeMB}MB`);
    }
    
    const allowedUpdates = [
      'message',
      'edited_message',
      'channel_post',
      'edited_channel_post',
      'inline_query',
      'chosen_inline_result',
      'callback_query',
      'my_chat_member',
      'chat_member'
    ];

    if (config.webhook.domain) {
      await bot.launch({
        webhook: {
          domain: config.webhook.domain,
          port: config.webhook.port,
          path: config.webhook.path
        },
        allowedUpdates
      });
      logger.info(`Bot started in webhook mode on ${config.webhook.domain}${config.webhook.path}`);
    } else {
      await bot.launch({
        dropPendingUpdates: true,
        allowedUpdates
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
