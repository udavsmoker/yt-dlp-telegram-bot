const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const config = require('../config');
const videoService = require('../services/video.service');
const audioService = require('../services/audio.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');
const { extractUrl, getUserInfo, cleanupFile, getFileForTelegram, isValidVideoUrl, isTikTokPhotoUrl, isTikTokUrl, isYouTubeUrl, isInstagramUrl, isInstagramPostUrl, getInstagramImgIndex, isBlueskyUrl, isBlueskyPostUrl, generateFilename } = require('../utils/helpers');

const userRequests = new Map();
const MAX_REQUESTS = 5;
const WINDOW_MS = 60000;

// Periodically clean up old rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [userId, requests] of userRequests.entries()) {
    const recent = requests.filter(time => now - time < WINDOW_MS);
    if (recent.length === 0) {
      userRequests.delete(userId);
    } else {
      userRequests.set(userId, recent);
    }
  }
}, 5 * 60 * 1000);

const pendingYouTubeDownloads = new Map();
const pendingInstagramDownloads = new Map();
const pendingAudioExtracts = new Map();

// Get sender name and caption prefix for download messages
// For users: returns { name: "First Last", caption: '<a href="tg://user?id=123">First Last</a>' }
// For channels: returns { name: "Channel Title", caption: 'Channel Title' }
function getSenderInfo(ctx) {
  if (ctx.chat?.type === 'channel') {
    const title = ctx.chat?.title || 'Channel';
    return { name: title, caption: title };
  }
  if (ctx.from) {
    const name = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
    return {
      name,
      caption: `<a href="tg://user?id=${ctx.from.id}">${name}</a>`
    };
  }
  // Fallback — use chat title
  const title = ctx.chat?.title || 'Channel';
  return { name: title, caption: title };
}

// Truncate title to avoid Telegram's 1024-char caption limit
function truncateTitle(title, maxLen = 200) {
  if (!title) return null;
  if (title.length <= maxLen) return title;
  return title.substring(0, maxLen) + '…';
}

/**
 * Build a caption string for a downloaded media item.
 * @param {object} sender - { caption: string } from getSenderInfo()
 * @param {string} url - Original URL
 * @param {object} info - { author, duration, fileSize, platform, quality, title }
 * @returns {string} HTML caption
 */
function buildCaption(sender, url, info) {
  const metaLines = [
    info.title && info.title !== 'Video' && info.title !== 'Bluesky Video' && info.title !== 'Bluesky Post'
      ? `${truncateTitle(info.title)}\n` : null,
    `👤 ${info.author || 'Unknown'}`,
    info.duration && info.duration !== 'Unknown' ? `⏱ ${info.duration}` : null,
    info.fileSize && info.fileSize !== 'Unknown' ? `💾 ${info.fileSize}` : null,
    `📱 ${info.platform || 'Unknown'}`,
    info.quality ? `📊 ${info.quality}` : null
  ].filter(Boolean).join('\n');

  return `${sender.caption} shared: <a href="${url}">Link</a>\n\n<blockquote expandable>${metaLines}</blockquote>`.trim();
}

/**
 * Send media items (photos and videos) to Telegram, handling batching (max 10 per group).
 * @param {object} ctx - Telegraf context
 * @param {Array<{type: 'photo'|'video', path: string, thumbnailPath?: string}>} mediaItems
 * @param {string} caption - HTML caption for the last batch
 * @param {object} videoMeta - { width, height, duration } for video items (optional)
 */
async function sendMediaToTelegram(ctx, mediaItems, caption, videoMeta = {}) {
  const TELEGRAM_MEDIA_LIMIT = 10;
  const batches = [];
  for (let i = 0; i < mediaItems.length; i += TELEGRAM_MEDIA_LIMIT) {
    batches.push(mediaItems.slice(i, i + TELEGRAM_MEDIA_LIMIT));
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const isLastBatch = batchIndex === batches.length - 1;

    if (batch.length === 1 && batches.length === 1) {
      const item = batch[0];
      if (item.type === 'photo') {
        await ctx.replyWithPhoto(getFileForTelegram(item.path), { caption, parse_mode: 'HTML' });
      } else {
        const opts = {
          caption, parse_mode: 'HTML', supports_streaming: true,
          width: videoMeta.width, height: videoMeta.height, duration: videoMeta.duration
        };
        if (item.thumbnailPath) opts.thumbnail = getFileForTelegram(item.thumbnailPath);
        await ctx.replyWithVideo(getFileForTelegram(item.path), opts);
      }
    } else {
      const mediaGroup = batch.map((item, index) => ({
        type: item.type,
        media: getFileForTelegram(item.path),
        caption: isLastBatch && index === 0 ? caption : undefined,
        parse_mode: isLastBatch && index === 0 ? 'HTML' : undefined,
        thumbnail: item.thumbnailPath ? getFileForTelegram(item.thumbnailPath) : undefined,
        ...(item.type === 'video' ? {
          supports_streaming: true,
          width: videoMeta.width, height: videoMeta.height, duration: videoMeta.duration
        } : {})
      }));

      try {
        await ctx.replyWithMediaGroup(mediaGroup);
      } catch (sendError) {
        if (sendError.message?.includes('caption is too long') || sendError.description?.includes('caption is too long')) {
          logger.warn(`Caption too long for batch ${batchIndex + 1}, retrying without caption`);
          const fallbackGroup = batch.map(item => ({
            type: item.type,
            media: getFileForTelegram(item.path),
          }));
          await ctx.replyWithMediaGroup(fallbackGroup);
        } else {
          throw sendError;
        }
      }
    }
    logger.info(`Sent batch ${batchIndex + 1}/${batches.length} (${batch.length} item(s))`);
  }
}

/**
 * Delete the user's original message and the status message.
 */
async function cleanupMessages(ctx, statusMessageId, originalMessageId) {
  try {
    if (originalMessageId) {
      await ctx.telegram.deleteMessage(ctx.chat.id, originalMessageId);
    }
  } catch {
    logger.warn('Could not delete user message (bot might not have permissions)');
  }
  if (statusMessageId) {
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
  }
}

// Check if bot is using local Bot API server
function isLocalBotApi() {
  return config.botApiUrl && (config.botApiUrl.includes('localhost') || config.botApiUrl.includes('127.0.0.1'));
}

// Get local file path for a Telegram file_id (works with both local and public API)
// For local Bot API: returns absolute local path directly from getFile
// For public API: downloads the file and returns temp path
async function getVideoLocalPath(ctx, fileId) {
  if (isLocalBotApi()) {
    // Local Bot API: getFile returns file_path as absolute local path
    const file = await ctx.telegram.getFile(fileId);
    const localPath = file.file_path;
    logger.info(`Local Bot API file path: ${localPath}`);
    return { localPath, needsCleanup: false };
  } else {
    // Public API: download via getFileLink
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const fileLinkStr = fileLink.toString();
    const axios = require('axios');
    const { generateFilename, ensureDir } = require('../utils/helpers');
    const fs = require('fs').promises;
    
    await ensureDir(config.download.tempDir);
    const videoPath = path.join(config.download.tempDir, generateFilename('audio_source', 'mp4'));
    
    const response = await axios({
      method: 'GET',
      url: fileLinkStr,
      responseType: 'arraybuffer',
      timeout: 120000
    });
    await fs.writeFile(videoPath, response.data);
    
    return { localPath: videoPath, needsCleanup: true };
  }
}

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
  
  if (isYouTubeUrl(url)) {
    logger.info(`YouTube link detected from ${userInfo}: ${url}`);
    
    const confirmMessage = await ctx.reply(
      'YouTube link detected!\n\nDo you want to download this video?',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Download', callback_data: 'yt_download' },
              { text: 'Just Sharing', callback_data: 'yt_cancel' }
            ]
          ]
        }
      }
    );
    
    pendingYouTubeDownloads.set(confirmMessage.message_id, {
      userId: ctx.from?.id,
      url: url,
      originalMessageId: message.message_id
    });
    
    setTimeout(() => {
      if (pendingYouTubeDownloads.has(confirmMessage.message_id)) {
        pendingYouTubeDownloads.delete(confirmMessage.message_id);
        ctx.telegram.deleteMessage(chatId, confirmMessage.message_id).catch(() => {});
      }
    }, 60000);
    
    return;
  }
  
  // Instagram carousel with specific photo index
  if (isInstagramPostUrl(url)) {
    const imgIndex = getInstagramImgIndex(url);
    if (imgIndex !== null) {
      logger.info(`Instagram carousel link with img_index=${imgIndex} from ${userInfo}: ${url}`);
      
      const confirmMessage = await ctx.reply(
        `📸 Instagram carousel detected!\n\nPhoto #${imgIndex} was selected. What would you like to download?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: `📷 Photo #${imgIndex}`, callback_data: 'insta_single' },
                { text: '📚 Download All', callback_data: 'insta_all' }
              ]
            ]
          }
        }
      );
      
      pendingInstagramDownloads.set(confirmMessage.message_id, {
        userId: ctx.from?.id,
        url: url,
        imgIndex: imgIndex,
        chatId: ctx.chat.id,
        originalMessageId: message.message_id,
        ctx: ctx
      });
      
      // Auto-download all after 15 seconds if no response
      setTimeout(async () => {
        if (pendingInstagramDownloads.has(confirmMessage.message_id)) {
          const pending = pendingInstagramDownloads.get(confirmMessage.message_id);
          pendingInstagramDownloads.delete(confirmMessage.message_id);
          
          // Delete the buttons message
          await ctx.telegram.deleteMessage(pending.chatId, confirmMessage.message_id).catch(() => {});
          
          // Auto-download all
          logger.info(`Instagram carousel timeout - auto-downloading all for ${userInfo}`);
          const statusMessage = await ctx.telegram.sendMessage(pending.chatId, '⏳ Processing your request...');
          processDownload(pending.ctx, pending.url, statusMessage, userInfo).catch(error => {
            logger.error(`Background Instagram download error for ${userInfo}:`, error);
          });
        }
      }, 15000);
      
      return;
    }
  }
  
  if (userId) {
    const now = Date.now();
    const requests = userRequests.get(userId) || [];
    const recentRequests = requests.filter(time => now - time < WINDOW_MS);
    
    if (recentRequests.length >= MAX_REQUESTS) {
      await ctx.reply('⏱ Please wait a moment before making another request.');
      return;
    }
    
    recentRequests.push(now);
    userRequests.set(userId, recentRequests);
  }
  
  logger.info(`Download request from ${userInfo}: ${url}`);
  
  const statusMessage = await ctx.reply('⏳ Processing your request...');
  
  // Process download in background without blocking other chats
  processDownload(ctx, url, statusMessage, userInfo).catch(error => {
    logger.error(`Background download error for ${userInfo}:`, error);
  });
}

async function processDownload(ctx, url, statusMessage, userInfo) {
  let filePath = null;
  let thumbnailPath = null;
  let filesToCleanup = [];
  let isInstagramPost = isInstagramPostUrl(url);
  const originalIsInstagramPost = isInstagramPost;
  
  try {
    let isTikTok = isTikTokUrl(url);
    let isBluesky = isBlueskyPostUrl(url);
    let triedVideo = false;
    
    // Handle Instagram posts (photos/carousels)
    if (isInstagramPost) {
      logger.info('Detected Instagram post URL, attempting photo download');
      
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          '⬇️ Downloading Instagram post...'
        );
        
        const result = await videoService.downloadInstagramPost(url);
        
        // If it's actually a video (or direct download couldn't find items), fall back to yt-dlp video download
        if (result.type === 'video' && result.shouldFallback) {
          logger.info('Instagram service could not download media directly, falling back to video download');
          isInstagramPost = false;
          // Continue to normal video download below
        } else if (result.type === 'mixed' || result.type === 'photos') {
          // Collect all media paths for cleanup
          if (result.imagePaths) filesToCleanup.push(...result.imagePaths);
          if (result.videoPaths) filesToCleanup.push(...result.videoPaths);
          
          const totalMedia = (result.imagePaths?.length || 0) + (result.videoPaths?.length || 0);
          logger.info(`Instagram post downloaded: ${result.imagePaths?.length || 0} image(s), ${result.videoPaths?.length || 0} video(s)`);
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );
          
          const sender = getSenderInfo(ctx);
          
          // Build media array with both photos and videos in order
          const allMedia = [];
          
          // Add images
          if (result.imagePaths) {
            for (const imagePath of result.imagePaths) {
              allMedia.push({ type: 'photo', path: imagePath });
            }
          }
          
          // Add videos
          if (result.videoPaths) {
            for (const videoPath of result.videoPaths) {
              allMedia.push({ type: 'video', path: videoPath });
            }
          }
          
          // If we have the ordered media array from the service, use that instead
          if (result.media && result.media.length > 0) {
            allMedia.length = 0;
            for (const m of result.media) {
              allMedia.push({ type: m.type, path: m.path, thumbnailPath: m.thumbnailPath });
              if (m.thumbnailPath) {
                filesToCleanup.push(m.thumbnailPath);
              }
            }
          }
          
          // Telegram allows max 10 media per group, split into batches
          const TELEGRAM_MEDIA_LIMIT = 10;
          const batches = [];
          
          for (let i = 0; i < allMedia.length; i += TELEGRAM_MEDIA_LIMIT) {
            const batch = allMedia.slice(i, i + TELEGRAM_MEDIA_LIMIT);
            batches.push(batch);
          }
          
          logger.info(`Sending ${allMedia.length} media item(s) in ${batches.length} batch(es)`);
          
          // Send each batch as a separate media group (or single item)
          for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const isLastBatch = batchIndex === batches.length - 1;
            
            if (batch.length === 1 && batches.length === 1) {
              // Single item - send individually
              const item = batch[0];
              const metaLines = [
                `👤 ${result.info.author}`,
                result.info.duration ? `⏱ ${result.info.duration}` : null,
                `💾 ${result.info.fileSize}`,
                `📱 ${result.info.platform}`,
                result.info.title ? `\n${truncateTitle(result.info.title)}` : null
              ].filter(Boolean).join('\n');
              const caption = `${sender.caption} shared: <a href="${url}">Link</a>\n\n<blockquote expandable>${metaLines}</blockquote>`.trim();
              
              if (item.type === 'photo') {
                await ctx.replyWithPhoto(
                  getFileForTelegram(item.path),
                  { caption, parse_mode: 'HTML' }
                );
              } else {
                await ctx.replyWithVideo(
                  getFileForTelegram(item.path),
                  { 
                    caption, 
                    parse_mode: 'HTML', 
                    supports_streaming: true,
                    width: result.width,
                    height: result.height,
                    duration: result.duration,
                    thumbnail: item.thumbnailPath ? getFileForTelegram(item.thumbnailPath) : undefined
                  }
                );
              }
            } else {
              const mediaMetaLines = [
                `👤 ${result.info.author}`,
                result.info.duration ? `⏱ ${result.info.duration}` : null,
                `💾 ${result.info.fileSize}`,
                `📱 ${result.info.platform}`,
                result.info.title ? `\n${truncateTitle(result.info.title)}` : null
              ].filter(Boolean).join('\n');
              const mediaCaption = `${sender.caption} shared: <a href="${url}">Link</a>\n\n<blockquote expandable>${mediaMetaLines}</blockquote>`.trim();

              const mediaGroup = batch.map((item, index) => ({
                type: item.type,
                media: getFileForTelegram(item.path),
                caption: isLastBatch && index === 0 ? mediaCaption : undefined,
                parse_mode: isLastBatch && index === 0 ? 'HTML' : undefined,
                thumbnail: item.thumbnailPath ? getFileForTelegram(item.thumbnailPath) : undefined,
                ...(item.type === 'video' ? { 
                  supports_streaming: true,
                  width: result.width,
                  height: result.height,
                  duration: result.duration
                } : {})
              }));
              
              await ctx.replyWithMediaGroup(mediaGroup);
            }
            logger.info(`Sent batch ${batchIndex + 1}/${batches.length} (${batch.length} item(s))`);
          }
          
          // Delete the user's message after successful upload
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
          } catch (error) {
            logger.warn('Could not delete user message (bot might not have permissions)');
          }
          
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
          
          logger.info(`Instagram post sent successfully to ${userInfo}`);
          return;
        }
      } catch (instaError) {
        logger.info(`Instagram post download failed, trying as video: ${instaError.message}`);
        isInstagramPost = false;
        // Fall through to try as video
      }
    }

    // Handle Bluesky posts (videos/images)
    if (isBluesky) {
      logger.info('Detected Bluesky URL, trying AT Protocol API first');
      
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          '⬇️ Downloading from Bluesky...'
        );
        
        const result = await videoService.downloadBlueskyPost(url);
        
        // Handle video type
        if (result.type === 'video') {
          filePath = result.filePath;
          thumbnailPath = result.thumbnailPath;
          
          logger.info('Bluesky video downloaded via API');
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );
          
          const sender = getSenderInfo(ctx);
          const caption = buildCaption(sender, url, result.info);
          
          await sendMediaToTelegram(
            ctx,
            [{ type: 'video', path: result.filePath, thumbnailPath: thumbnailPath || undefined }],
            caption,
            { width: result.width, height: result.height, duration: result.duration }
          );
          
          await cleanupMessages(ctx, statusMessage.message_id, ctx.message.message_id);
          logger.info(`Bluesky video sent successfully to ${userInfo}`);
          return;
        }
        
        // Handle slideshow type (images)
        if (result.type === 'slideshow') {
          filesToCleanup = [...result.imagePaths];
          
          logger.info(`Bluesky images downloaded: ${result.imagePaths.length} image(s)`);
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading photos to Telegram...'
          );
          
          const sender = getSenderInfo(ctx);
          const caption = buildCaption(sender, url, result.info);
          const mediaItems = result.imagePaths.map(imagePath => ({ type: 'photo', path: imagePath }));
          
          await sendMediaToTelegram(ctx, mediaItems, caption);
          await cleanupMessages(ctx, statusMessage.message_id, ctx.message.message_id);
          logger.info(`Bluesky images sent successfully to ${userInfo}`);
          return;
        }
        
      } catch (apiError) {
        logger.info(`Bluesky API failed, trying yt-dlp fallback: ${apiError.message}`);
        
        // Cleanup any partial downloads
        if (filePath) await cleanupFile(filePath);
        if (thumbnailPath) await cleanupFile(thumbnailPath);
        for (const file of filesToCleanup) await cleanupFile(file);
        filePath = null;
        thumbnailPath = null;
        filesToCleanup = [];
        
        // If the error is about non-downloadable content, don't try yt-dlp
        if (apiError.message.includes('only text') || apiError.message.includes('link card')) {
          throw apiError;
        }
        
        // Fall back to yt-dlp for video download
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '⬇️ Trying fallback download method...'
          );
          
          const result = await videoService.download(url);
          filePath = result.filePath;
          thumbnailPath = result.thumbnailPath;
          
          logger.info('Bluesky video downloaded via yt-dlp fallback');
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );
          
          const sender = getSenderInfo(ctx);
          const caption = buildCaption(sender, url, result.info);
          
          await sendMediaToTelegram(
            ctx,
            [{ type: 'video', path: result.filePath, thumbnailPath: thumbnailPath || undefined }],
            caption,
            { width: result.width, height: result.height, duration: result.duration }
          );
          
          await cleanupMessages(ctx, statusMessage.message_id, ctx.message.message_id);
          logger.info(`Bluesky video (via yt-dlp) sent successfully to ${userInfo}`);
          return;
          
        } catch (ytdlpError) {
          logger.error('Both Bluesky API and yt-dlp failed');
          throw apiError; // Throw the original API error
        }
      }
    }
    
    if (isTikTok) {
      logger.info('Detected TikTok URL, trying TikTok API first (handles both videos and photos)');
      
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          '⬇️ Downloading from TikTok...'
        );
        
        // Try TikTok API first - it's faster and handles both videos and photos
        const result = await videoService.downloadTikTokSlideshow(url);
        
        // Handle video type from TikTok API
        if (result.type === 'video') {
          filePath = result.filePath;
          thumbnailPath = result.thumbnailPath;
          
          logger.info(`TikTok video downloaded via API`);
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );
          
          const sender = getSenderInfo(ctx);
          const caption = buildCaption(sender, url, result.info);
          
          await sendMediaToTelegram(
            ctx,
            [{ type: 'video', path: result.filePath, thumbnailPath: thumbnailPath || undefined }],
            caption,
            { width: result.width, height: result.height, duration: result.duration }
          );
          
          await cleanupMessages(ctx, statusMessage.message_id, ctx.message.message_id);
          logger.info(`TikTok video (via API) sent successfully to ${userInfo}`);
          return;
        }
        
        // Handle slideshow type (images)
        if (result.type === 'slideshow' || result.type === 'image') {
          filesToCleanup = [...result.imagePaths];
          
          logger.info(`TikTok slideshow downloaded: ${result.imagePaths.length} images`);
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading photos to Telegram...'
          );
          
          const sender = getSenderInfo(ctx);
          const caption = buildCaption(sender, url, result.info);
          const mediaItems = result.imagePaths.map(p => ({ type: 'photo', path: p }));
          
          await sendMediaToTelegram(ctx, mediaItems, caption);
          await cleanupMessages(ctx, statusMessage.message_id, ctx.message.message_id);
          logger.info(`TikTok slideshow sent successfully to ${userInfo}`);
          return;
        }
        
      } catch (apiError) {
        logger.info(`TikTok API failed, trying yt-dlp fallback: ${apiError.message}`);
        
        // Cleanup any partial downloads
        if (filePath) await cleanupFile(filePath);
        if (thumbnailPath) await cleanupFile(thumbnailPath);
        for (const file of filesToCleanup) await cleanupFile(file);
        filePath = null;
        thumbnailPath = null;
        filesToCleanup = [];
        
        // Fall back to yt-dlp for video download
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '⬇️ Trying fallback download method...'
          );
          
          const result = await videoService.download(url);
          filePath = result.filePath;
          thumbnailPath = result.thumbnailPath;
          
          logger.info(`TikTok video downloaded via yt-dlp fallback`);
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading to Telegram...'
          );
          
          const sender = getSenderInfo(ctx);
          const caption = buildCaption(sender, url, result.info);
          
          await sendMediaToTelegram(
            ctx,
            [{ type: 'video', path: result.filePath, thumbnailPath: thumbnailPath || undefined }],
            caption,
            { width: result.width, height: result.height, duration: result.duration }
          );
          
          await cleanupMessages(ctx, statusMessage.message_id, ctx.message.message_id);
          logger.info(`TikTok video (via yt-dlp) sent successfully to ${userInfo}`);
          return;
          
        } catch (ytdlpError) {
          logger.error(`Both TikTok API and yt-dlp failed`);
          throw apiError; // Throw the original API error
        }
      }
    }
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '⬇️ Downloading video...\nThis may take a moment for large videos.'
    );
    
    const result = await videoService.download(url);
    
    if (result.type === 'slideshow' || result.type === 'image') {
      const sender = getSenderInfo(ctx);
      if (result.imagePaths) filesToCleanup.push(...result.imagePaths);
      
      logger.info(`Slideshow/Images downloaded: ${(result.imagePaths || []).length} images`);
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        '📤 Uploading photos to Telegram...'
      );
      
      if (result.imagePaths && result.imagePaths.length > 0) {
        const caption = buildCaption(sender, url, result.info || {});
        const mediaItems = result.imagePaths.map(p => ({ type: 'photo', path: p }));
        await sendMediaToTelegram(ctx, mediaItems, caption);
      }
      
      await cleanupMessages(ctx, statusMessage.message_id, ctx.message.message_id);
      return;
    }

    filePath = result.filePath;
    thumbnailPath = result.thumbnailPath;
    
    logger.info(`Video downloaded, platform: ${result.info.platform}`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading to Telegram...'
    );
    
    const sender = getSenderInfo(ctx);
    const caption = buildCaption(sender, url, result.info);
    
    await sendMediaToTelegram(
      ctx,
      [{ type: 'video', path: result.filePath, thumbnailPath: thumbnailPath || undefined }],
      caption,
      { width: result.width, height: result.height, duration: result.duration }
    );
    
    await cleanupMessages(ctx, statusMessage.message_id, ctx.message.message_id);
    logger.info(`Video sent successfully to ${userInfo}`);
    
  } catch (error) {
    logger.error(`Download failed for ${userInfo}: ${error.message}`);
    
    let safeErrorMsg = error.message ? error.message.replace(/[_*[\]`~>#+\-=|{}.!()\\]/g, ' ').trim() : 'Unknown error';
    if (safeErrorMsg.startsWith('YTDLP_ERROR:')) {
      safeErrorMsg = safeErrorMsg.replace('YTDLP_ERROR:', '').trim();
    }

    if (originalIsInstagramPost && safeErrorMsg.includes('There is no video in this post')) {
      safeErrorMsg = 'Failed to download Instagram photo post. The photo service was temporarily unavailable, please try again in a few moments.';
    }
    
    const errorText = `❌ ${safeErrorMsg}\n\n*Troubleshooting:*\n• Ensure link is valid\n• ${originalIsInstagramPost ? 'Post' : 'Video'} must be public\n• Max size: ${ctx.telegram.options?.apiRoot?.includes('localhost') ? '2000' : '50'}MB\n• Platform must be supported`;
    
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        errorText,
        { parse_mode: 'Markdown' }
      );
    } catch (editError) {
      // If Markdown parsing fails, retry without parse_mode
      try {
        const plainText = errorText.replace(/[*_`]/g, '');
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          plainText
        );
      } catch (finalError) {
        logger.error(`Failed to send error message to ${userInfo}: ${finalError.message}`);
      }
    }
  } finally {
    if (filePath) {
      await cleanupFile(filePath);
    }
    if (thumbnailPath) {
      await cleanupFile(thumbnailPath);
    }
    for (const file of filesToCleanup) {
      await cleanupFile(file);
    }
  }
}

// Handle YouTube download confirmation button clicks
async function handleYouTubeCallback(ctx) {
  const callbackData = ctx.callbackQuery.data;
  const messageId = ctx.callbackQuery.message.message_id;
  const userId = ctx.from?.id;
  
  // Check if this is a pending YouTube download
  const pendingDownload = pendingYouTubeDownloads.get(messageId);
  
  if (!pendingDownload) {
    await ctx.answerCbQuery('⚠️ This request has expired.');
    await ctx.deleteMessage().catch(() => {});
    return;
  }
  
  // Verify only the original sender can press the buttons (if recorded, skip check for channels)
  if (pendingDownload.userId && pendingDownload.userId !== userId) {
    await ctx.answerCbQuery('⚠️ Only the person who shared the link can use these buttons.', { show_alert: true });
    return;
  }
  
  // Clean up pending state
  pendingYouTubeDownloads.delete(messageId);
  
  if (callbackData === 'yt_cancel') {
    await ctx.answerCbQuery('👍 Link shared without download');
    await ctx.deleteMessage().catch(() => {});
    logger.info(`YouTube download cancelled by user ${userId}`);
    return;
  }
  
  if (callbackData === 'yt_download') {
    await ctx.answerCbQuery('⬇️ Starting download...');
    
    // Delete the confirmation message
    await ctx.deleteMessage().catch(() => {});
    
    // Apply rate limiting
    const now = Date.now();
    const requests = userRequests.get(userId) || [];
    const recentRequests = requests.filter(time => now - time < WINDOW_MS);
    
    if (recentRequests.length >= MAX_REQUESTS) {
      await ctx.reply('⏱ Please wait a moment before making another request.');
      return;
    }
    
    recentRequests.push(now);
    userRequests.set(userId, recentRequests);
    
    const userInfo = getUserInfo(ctx);
    const url = pendingDownload.url;
    
    logger.info(`YouTube download confirmed by ${userInfo}: ${url}`);
    
    // Process YouTube download in background
    processYouTubeDownload(ctx, url, userInfo, pendingDownload.originalMessageId).catch(error => {
      logger.error(`Background YouTube download error for ${userInfo}:`, error);
    });
  }
}

// Handle Instagram carousel confirmation button clicks
async function handleInstagramCallback(ctx) {
  const callbackData = ctx.callbackQuery.data;
  const messageId = ctx.callbackQuery.message.message_id;
  const userId = ctx.from?.id;
  
  const pendingDownload = pendingInstagramDownloads.get(messageId);
  
  if (!pendingDownload) {
    await ctx.answerCbQuery('⚠️ This request has expired.');
    await ctx.deleteMessage().catch(() => {});
    return;
  }
  
  if (pendingDownload.userId && pendingDownload.userId !== userId) {
    await ctx.answerCbQuery('⚠️ Only the person who shared the link can use these buttons.', { show_alert: true });
    return;
  }
  
  pendingInstagramDownloads.delete(messageId);
  
  await ctx.answerCbQuery('⬇️ Starting download...');
  await ctx.deleteMessage().catch(() => {});
  
  const userInfo = getUserInfo(ctx);
  const url = pendingDownload.url;
  const imgIndex = callbackData === 'insta_single' ? pendingDownload.imgIndex : null;
  
  logger.info(`Instagram carousel ${callbackData === 'insta_single' ? `photo #${imgIndex}` : 'all'} download confirmed by ${userInfo}`);
  
  // Rate limiting
  const now = Date.now();
  const requests = userRequests.get(userId) || [];
  const recentRequests = requests.filter(time => now - time < WINDOW_MS);
  
  if (recentRequests.length >= MAX_REQUESTS) {
    await ctx.reply('⏱ Please wait a moment before making another request.');
    return;
  }
  
  recentRequests.push(now);
  userRequests.set(userId, recentRequests);
  
  const statusMessage = await ctx.reply('⏳ Processing your request...');
  
  // Process download — pass imgIndex to processInstagramDownload
  processInstagramDownload(ctx, url, statusMessage, userInfo, imgIndex, pendingDownload.originalMessageId).catch(error => {
    logger.error(`Background Instagram download error for ${userInfo}:`, error);
  });
}

async function processInstagramDownload(ctx, url, statusMessage, userInfo, imgIndex, originalMessageId) {
  let filePath = null;
  let thumbnailPath = null;
  let filesToCleanup = [];
  
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '⬇️ Downloading Instagram post...'
    );
    
    const result = await videoService.downloadInstagramPost(url, imgIndex);
    
    if (result.type === 'video' && result.shouldFallback) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        '⬇️ Downloading video...\nThis may take a moment for large videos.'
      );
      
      const videoResult = await videoService.download(url);
      filePath = videoResult.filePath;
      thumbnailPath = videoResult.thumbnailPath;
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        '📤 Uploading to Telegram...'
      );
      
      const sender = getSenderInfo(ctx);
      const caption = buildCaption(sender, url, videoResult.info);
      
      await sendMediaToTelegram(
        ctx,
        [{ type: 'video', path: filePath, thumbnailPath: thumbnailPath || undefined }],
        caption,
        { width: videoResult.width, height: videoResult.height, duration: videoResult.duration }
      );
      
      await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
      logger.info(`Instagram video sent successfully to ${userInfo}`);
      return;
    }
    
    if (result.imagePaths) filesToCleanup.push(...result.imagePaths);
    if (result.videoPaths) filesToCleanup.push(...result.videoPaths);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading to Telegram...'
    );
    
    const sender = getSenderInfo(ctx);
    
    const allMedia = [];
    if (result.imagePaths) {
      for (const imagePath of result.imagePaths) {
        allMedia.push({ type: 'photo', path: imagePath });
      }
    }
    if (result.videoPaths) {
      for (const videoPath of result.videoPaths) {
        allMedia.push({ type: 'video', path: videoPath });
      }
    }
    if (result.media && result.media.length > 0) {
      allMedia.length = 0;
      for (const m of result.media) {
        allMedia.push({ type: m.type, path: m.path, thumbnailPath: m.thumbnailPath });
        if (m.thumbnailPath) filesToCleanup.push(m.thumbnailPath);
      }
    }
    
    const caption = buildCaption(sender, url, result.info);
    
    await sendMediaToTelegram(ctx, allMedia, caption, {
      width: result.width,
      height: result.height,
      duration: result.duration
    });
    
    await cleanupMessages(ctx, statusMessage.message_id, originalMessageId);
    logger.info(`Instagram post sent successfully to ${userInfo}`);
  } catch (error) {
    logger.error(`Instagram download failed for ${userInfo}: ${error.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ ${error.message}\n\n*Troubleshooting:*\n• Ensure link is valid\n• Post must be public\n• Max size: ${ctx.telegram.options?.apiRoot?.includes('localhost') ? '2000' : '50'}MB\n• Platform must be supported`,
      { parse_mode: 'Markdown' }
    );
  } finally {
    if (filePath) await cleanupFile(filePath);
    if (thumbnailPath) await cleanupFile(thumbnailPath);
    for (const file of filesToCleanup) {
      await cleanupFile(file);
    }
  }
}

async function processYouTubeDownload(ctx, url, userInfo, originalMessageId) {
  const statusMessage = await ctx.reply('⏳ Processing your request...');
  
  let filePath = null;
  let thumbnailPath = null;
  
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '⬇️ Downloading video...\nThis may take a moment for large videos.'
    );
    
    const result = await videoService.download(url);
    filePath = result.filePath;
    thumbnailPath = result.thumbnailPath;
    
    logger.info(`YouTube video downloaded, platform: ${result.info.platform}`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading to Telegram...'
    );
    
    const sender = getSenderInfo(ctx);
    
    const qualityLine = result.info.quality ? `📊 Quality: ${result.info.quality}` : '';
    
    const ytMetaLines = [
      result.info.title && result.info.title !== 'Video' ? `🎬 ${truncateTitle(result.info.title)}\n` : null,
      `👤 ${result.info.author}`,
      `⏱ ${result.info.duration}`,
      `💾 ${result.info.fileSize}`,
      `📱 ${result.info.platform}`,
      qualityLine || null
    ].filter(Boolean).join('\n');
    
    const videoOptions = {
      caption: `${sender.caption} shared: <a href="${url}">Link</a>\n\n<blockquote expandable>${ytMetaLines}</blockquote>`.trim(),
      parse_mode: 'HTML',
      supports_streaming: true,
      width: result.width,
      height: result.height,
      duration: result.duration,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎵 Audio', callback_data: 'yt_audio' }]
        ]
      }
    };
    
    if (thumbnailPath) {
      videoOptions.thumbnail = getFileForTelegram(thumbnailPath);
    }
    
    const sentVideo = await ctx.replyWithVideo(
      getFileForTelegram(result.filePath),
      videoOptions
    );
    
    if (sentVideo?.video?.file_id) {
      pendingAudioExtracts.set(sentVideo.message_id, {
        videoFileId: sentVideo.video.file_id,
        thumbnailFileId: sentVideo.video.thumbnail?.file_id || sentVideo.video.thumb?.file_id,
        userId: ctx.from?.id,
        title: result.info.title,
        author: result.info.author
      });
      
      // Clean up after 10 minutes
      setTimeout(() => {
        pendingAudioExtracts.delete(sentVideo.message_id);
      }, 600000);
    }
    
    // Delete original user message if possible
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, originalMessageId);
    } catch (error) {
      logger.warn('Could not delete user message (bot might not have permissions)');
    }
    
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
    
    logger.info(`YouTube video sent successfully to ${userInfo}`);
    
  } catch (error) {
    logger.error(`YouTube download failed for ${userInfo}: ${error.message}`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ ${error.message}\n\n*Troubleshooting:*\n• Ensure link is valid\n• Video must be public\n• Max size: ${ctx.telegram.options?.apiRoot?.includes('localhost') ? '2000' : '50'}MB`,
      { parse_mode: 'Markdown' }
    );
  } finally {
    if (filePath) {
      await cleanupFile(filePath);
    }
    if (thumbnailPath) {
      await cleanupFile(thumbnailPath);
    }
  }
}

// Handle /mp3 command (reply to a video)
async function handleMp3Command(ctx) {
  const replyMessage = ctx.message?.reply_to_message;
  
  if (!replyMessage) {
    await ctx.reply('💡 Reply to a video message with /mp3 to extract audio.');
    return;
  }
  
  const video = replyMessage.video;
  if (!video) {
    await ctx.reply('⚠️ The replied message does not contain a video.');
    return;
  }
  
  let title = 'Audio';
  let author = 'Unknown';
  
  // Try to extract title and author from the original message caption
  if (replyMessage.caption) {
    const titleMatch = replyMessage.caption.match(/🎬\s+([^\n]+)/);
    if (titleMatch) title = titleMatch[1].trim();
    
    const authorMatch = replyMessage.caption.match(/👤\s+([^\n]+)/);
    if (authorMatch) author = authorMatch[1].trim();
  }
  
  const thumbnailFileId = video.thumbnail?.file_id || video.thumb?.file_id;
  
  const userInfo = getUserInfo(ctx);
  logger.info(`MP3 extraction requested by ${userInfo}`);
  
  const statusMessage = await ctx.reply('🎵 Extracting audio...');
  
  let videoPath = null;
  let audioResult = null;
  let thumbPath = null;
  
  try {
    const videoFile = await getVideoLocalPath(ctx, video.file_id);
    if (videoFile.needsCleanup) videoPath = videoFile.localPath;
    
    if (thumbnailFileId) {
      try {
        const thumbFile = await ctx.telegram.getFile(thumbnailFileId);
        thumbPath = path.join(config.download.tempDir, generateFilename('audio_thumb', 'jpg'));
        
        if (thumbFile.file_path && thumbFile.file_path.startsWith('/')) {
          await fs.copyFile(thumbFile.file_path, thumbPath);
        } else {
          const thumbLink = await ctx.telegram.getFileLink(thumbnailFileId);
          const thumbRes = await axios.get(thumbLink.href, { responseType: 'arraybuffer' });
          await fs.writeFile(thumbPath, thumbRes.data);
        }
      } catch (err) {
        logger.warn(`Failed to download thumbnail for audio: ${err.message}`);
        thumbPath = null;
      }
    }
    
    audioResult = await audioService.convertToMp3(videoFile.localPath, thumbPath);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading audio...'
    );
    
    const audioOptions = {
      title: (title !== 'Audio' ? title : null) || (audioResult.title !== 'Audio' ? audioResult.title : undefined),
      performer: (author !== 'Unknown' ? author : null) || (audioResult.artist !== 'Unknown' ? audioResult.artist : undefined),
      duration: audioResult.duration || undefined,
      reply_to_message_id: replyMessage.message_id
    };
    
    if (thumbPath) {
      audioOptions.thumbnail = getFileForTelegram(thumbPath);
    }
    
    await ctx.replyWithAudio(
      getFileForTelegram(audioResult.audioPath),
      audioOptions
    );
    
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
    logger.info(`MP3 sent successfully to ${userInfo}`);
    
  } catch (error) {
    logger.error(`MP3 extraction failed for ${userInfo}: ${error.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ Audio extraction failed: ${error.message}`
    );
  } finally {
    if (videoPath) await cleanupFile(videoPath);
    if (audioResult?.audioPath) await cleanupFile(audioResult.audioPath);
    if (thumbPath) await cleanupFile(thumbPath);
  }
}

// Handle YouTube audio button callback
async function handleAudioCallback(ctx) {
  const messageId = ctx.callbackQuery.message.message_id;
  const userId = ctx.from?.id;
  
  const pending = pendingAudioExtracts.get(messageId);
  
  if (!pending) {
    const videoMsg = ctx.callbackQuery.message;
    if (!videoMsg?.video) {
      await ctx.answerCbQuery('⚠️ This request has expired.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('🎵 Extracting audio...');
    await processAudioExtraction(ctx, videoMsg.video.file_id, userId, null, null);
    return;
  }
  
  await ctx.answerCbQuery('🎵 Extracting audio...');
  
  // Remove inline keyboard from the video message
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch {}
  
  await processAudioExtraction(ctx, pending.videoFileId, userId, pending.title, pending.author, pending.thumbnailFileId);
}

// Extract audio from a video file ID
async function processAudioExtraction(ctx, videoFileId, userId, title, author, thumbnailFileId) {
  const userInfo = getUserInfo(ctx);
  const statusMessage = await ctx.reply('🎵 Extracting audio...');
  
  let videoPath = null;
  let audioResult = null;
  let thumbPath = null;
  
  try {
    const videoFile = await getVideoLocalPath(ctx, videoFileId);
    if (videoFile.needsCleanup) videoPath = videoFile.localPath;
    
    if (thumbnailFileId) {
      try {
        const thumbFile = await ctx.telegram.getFile(thumbnailFileId);
        thumbPath = path.join(config.download.tempDir, generateFilename('audio_thumb', 'jpg'));
        
        if (thumbFile.file_path && thumbFile.file_path.startsWith('/')) {
          await fs.copyFile(thumbFile.file_path, thumbPath);
        } else {
          const thumbLink = await ctx.telegram.getFileLink(thumbnailFileId);
          const thumbRes = await axios.get(thumbLink.href, { responseType: 'arraybuffer' });
          await fs.writeFile(thumbPath, thumbRes.data);
        }
      } catch (err) {
        logger.warn(`Failed to download thumbnail for audio: ${err.message}`);
        thumbPath = null;
      }
    }
    
    audioResult = await audioService.convertToMp3(videoFile.localPath, thumbPath);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading audio...'
    );
    
    const audioOptions = {
      title: title || (audioResult.title !== 'Audio' ? audioResult.title : undefined),
      performer: author || (audioResult.artist !== 'Unknown' ? audioResult.artist : undefined),
      duration: audioResult.duration || undefined
    };
    
    if (thumbPath) {
      audioOptions.thumbnail = getFileForTelegram(thumbPath);
    }
    
    await ctx.replyWithAudio(
      getFileForTelegram(audioResult.audioPath),
      audioOptions
    );
    
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
    logger.info(`Audio extracted and sent successfully to ${userInfo}`);
    
  } catch (error) {
    logger.error(`Audio extraction failed for ${userInfo}: ${error.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ Audio extraction failed: ${error.message}`
    );
  } finally {
    if (videoPath) await cleanupFile(videoPath);
    if (audioResult?.audioPath) await cleanupFile(audioResult.audioPath);
    if (thumbPath) await cleanupFile(thumbPath);
  }
}

module.exports = { 
  handleDownload, 
  handleYouTubeCallback, 
  handleInstagramCallback, 
  handleMp3Command, 
  handleAudioCallback 
};
