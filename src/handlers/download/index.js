const {
  extractUrl,
  getUserInfo,
  isValidVideoUrl,
  isInstagramPostUrl,
  getInstagramImgIndex
} = require('../../utils/helpers');
const settingsService = require('../../services/settings.service');
const logger = require('../../utils/logger');
const { downloadLimiter } = require('../../middleware/rate-limit.middleware');

const YouTubeStrategy = require('./strategies/youtube.strategy');
const InstagramStrategy = require('./strategies/instagram.strategy');
const TikTokStrategy = require('./strategies/tiktok.strategy');
const BlueskyStrategy = require('./strategies/bluesky.strategy');
const SpotifyStrategy = require('./strategies/spotify.strategy');
const GenericStrategy = require('./strategies/generic.strategy');
const { handleMp3Command, handleAudioCallback } = require('./audio/audio-extractor');

const youtubeStrategy = new YouTubeStrategy();
const instagramStrategy = new InstagramStrategy();
const tiktokStrategy = new TikTokStrategy();
const blueskyStrategy = new BlueskyStrategy();
const spotifyStrategy = new SpotifyStrategy();
const genericStrategy = new GenericStrategy();

const strategies = [
  youtubeStrategy,
  instagramStrategy,
  tiktokStrategy,
  blueskyStrategy,
  spotifyStrategy,
  genericStrategy
];

/**
 * Main middleware for intercepting video/media links in messages and channel posts.
 * @param {object} ctx - Telegraf context
 * @param {Function} next - Telegraf next middleware
 */
async function handleDownload(ctx, next) {
  const userInfo = getUserInfo(ctx);
  const message = ctx.message || ctx.channelPost;
  if (!message) {
    return next();
  }
  const messageText = message.text || message.caption;
  if (!messageText) {
    return next();
  }

  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;

  const url = extractUrl(messageText);

  if (!url || !isValidVideoUrl(url)) {
    return next();
  }

  if (!settingsService.isFeatureEnabled(chatId, 'videoDownload')) {
    logger.info(`Video download disabled for chat ${chatId}, ignoring URL`);
    return next();
  }

  const originalMessageId = message.message_id;

  // YouTube prompt check (quality selection keyboard)
  if (youtubeStrategy.canHandle(url)) {
    return youtubeStrategy.handle(ctx, { url, userInfo, originalMessageId });
  }

  // Instagram carousel prompt check (photo index prompt)
  if (isInstagramPostUrl(url)) {
    const imgIndex = getInstagramImgIndex(url);
    if (imgIndex !== null) {
      return instagramStrategy.handle(ctx, { url, userInfo, originalMessageId });
    }
  }

  // Spotify check (single track or album/playlist prompt)
  if (spotifyStrategy.canHandle(url)) {
    if (userId) {
      const rateLimit = downloadLimiter.check(String(userId));
      if (rateLimit.limited) {
        await ctx.reply('⏱ Please wait a moment before making another request.');
        return;
      }
    }
    return spotifyStrategy.handle(ctx, { url, userInfo, originalMessageId });
  }

  // Rate limiting for immediate downloads
  if (userId) {
    const rateLimit = downloadLimiter.check(String(userId));
    if (rateLimit.limited) {
      await ctx.reply('⏱ Please wait a moment before making another request.');
      return;
    }
  }

  logger.info(`Download request from ${userInfo}: ${url}`);

  const statusMessage = await ctx.reply('⏳ Processing your request...');

  // Dispatch to the first matching strategy
  const strategy = strategies.find(s => s.canHandle(url)) || genericStrategy;

  strategy.handle(ctx, { url, userInfo, originalMessageId, statusMessage }).catch(error => {
    logger.error(`Background download error for ${userInfo} in ${strategy.name}:`, error);
  });
}

/**
 * Handle callback queries from YouTube inline keyboard.
 * @param {object} ctx
 */
async function handleYouTubeCallback(ctx) {
  return youtubeStrategy.handleCallback(ctx);
}

/**
 * Handle callback queries from Instagram carousel inline keyboard.
 * @param {object} ctx
 */
async function handleInstagramCallback(ctx) {
  return instagramStrategy.handleCallback(ctx);
}

/**
 * Handle callback queries from Spotify inline keyboard.
 * @param {object} ctx
 */
async function handleSpotifyCallback(ctx) {
  return spotifyStrategy.handleCallback(ctx);
}

module.exports = {
  handleDownload,
  handleYouTubeCallback,
  handleInstagramCallback,
  handleSpotifyCallback,
  handleMp3Command,
  handleAudioCallback,
  youtubeStrategy,
  spotifyStrategy
};
