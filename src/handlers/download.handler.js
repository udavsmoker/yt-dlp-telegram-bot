const { Input } = require('telegraf');
const videoService = require('../services/video.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');
const { extractUrl, getUserInfo, cleanupFile, isValidVideoUrl, isTikTokPhotoUrl, isTikTokUrl, isYouTubeUrl } = require('../utils/helpers');

const userRequests = new Map();
const MAX_REQUESTS = 5;
const WINDOW_MS = 60000;

const pendingYouTubeDownloads = new Map();

async function handleDownload(ctx, next) {
  const userInfo = getUserInfo(ctx);
  const messageText = ctx.message.text;
  
  const url = extractUrl(messageText);
  
  if (!url || !isValidVideoUrl(url)) {
    return next();
  }

  const chatId = ctx.chat.id;
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
      userId: ctx.from.id,
      url: url,
      originalMessageId: ctx.message.message_id
    });
    
    setTimeout(() => {
      if (pendingYouTubeDownloads.has(confirmMessage.message_id)) {
        pendingYouTubeDownloads.delete(confirmMessage.message_id);
        ctx.telegram.deleteMessage(chatId, confirmMessage.message_id).catch(() => {});
      }
    }, 60000);
    
    return;
  }
  
  const userId = ctx.from?.id;
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
  
  let filePath = null;
  let thumbnailPath = null;
  let filesToCleanup = [];
  
  try {
    let isTikTok = isTikTokUrl(url);
    let triedVideo = false;
    
    if (isTikTok) {
      logger.info('Detected TikTok URL, attempting video download first');
      
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          '⬇️ Downloading video with yt-dlp...\nThis may take a moment for large videos.'
        );
        
        const result = await videoService.download(url);
        filePath = result.filePath;
        thumbnailPath = result.thumbnailPath;
        triedVideo = true;
        
        logger.info(`TikTok video downloaded, platform: ${result.info.platform}`);
        
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          '📤 Uploading to Telegram...'
        );
        
        const senderName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
        
        const qualityLine = result.info.quality ? `📊 Quality: ${result.info.quality}\n` : '';
        const fileSizeLine = result.info.fileSize ? `💾 Size: ${result.info.fileSize}\n` : '';
        
        const videoOptions = {
          caption: `<a href="tg://user?id=${ctx.from.id}">${senderName}</a> shared: <a href="${url}">Link</a>

<blockquote expandable>👤 ${result.info.author}
⏱ ${result.info.duration}
💾 ${result.info.fileSize}
📱 ${result.info.platform}
${qualityLine}</blockquote>`.trim(),
          parse_mode: 'HTML',
          supports_streaming: true,
          width: result.width,
          height: result.height,
          duration: result.duration
        };
        
        if (thumbnailPath) {
          videoOptions.thumbnail = Input.fromLocalFile(thumbnailPath);
        }
        
        await ctx.replyWithVideo(
          Input.fromLocalFile(result.filePath),
          videoOptions
        );
        
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
        } catch (error) {
          logger.warn('Could not delete user message (bot might not have permissions)');
        }
        
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
        
        logger.info(`TikTok video sent successfully to ${userInfo}`);
        return;
        
      } catch (videoError) {
        logger.info(`Video download failed, trying slideshow: ${videoError.message}`);
        
        if (filePath) await cleanupFile(filePath);
        if (thumbnailPath) await cleanupFile(thumbnailPath);
        filePath = null;
        thumbnailPath = null;
        
        try {
          const result = await videoService.downloadTikTokSlideshow(url);
          filesToCleanup = [...result.imagePaths];
          
          logger.info(`TikTok slideshow downloaded: ${result.imagePaths.length} images`);
          
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            null,
            '📤 Uploading photos to Telegram...'
          );
          
          const senderName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
          
          // Telegram allows max 10 media per group, split into batches
          const TELEGRAM_MEDIA_LIMIT = 10;
          const batches = [];
          
          for (let i = 0; i < result.imagePaths.length; i += TELEGRAM_MEDIA_LIMIT) {
            const batch = result.imagePaths.slice(i, i + TELEGRAM_MEDIA_LIMIT);
            batches.push(batch);
          }
          
          logger.info(`Sending ${result.imagePaths.length} images in ${batches.length} batch(es)`);
          
          // Send each batch as a separate media group
          for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const isLastBatch = batchIndex === batches.length - 1;
            
            const mediaGroup = batch.map((imagePath, index) => ({
              type: 'photo',
              media: Input.fromLocalFile(imagePath),
              // Only add caption to first image of last batch
              caption: isLastBatch && index === 0 ? `<a href="tg://user?id=${ctx.from.id}">${senderName}</a> shared: <a href="${url}">Link</a>

<blockquote expandable>${result.info.title}
👤 ${result.info.author}
📱 ${result.info.platform}</blockquote>`.trim() : undefined,
              parse_mode: isLastBatch && index === 0 ? 'HTML' : undefined
            }));
            
            await ctx.replyWithMediaGroup(mediaGroup);
            logger.info(`Sent batch ${batchIndex + 1}/${batches.length} (${batch.length} images)`);
          }
          
          // Delete the user's message after successful upload
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
          } catch (error) {
            logger.warn('Could not delete user message (bot might not have permissions)');
          }
          
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
          
          logger.info(`TikTok slideshow sent successfully to ${userInfo}`);
          return;
        } catch (slideshowError) {
          logger.error(`Both video and slideshow download failed for TikTok URL`);
          throw videoError;
        }
      }
    }
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '⬇️ Downloading video with yt-dlp...\nThis may take a moment for large videos.'
    );
    
    const result = await videoService.download(url);
    filePath = result.filePath;
    thumbnailPath = result.thumbnailPath;
    
    logger.info(`Video downloaded, platform: ${result.info.platform}`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading to Telegram...'
    );
    
    const senderName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
    
    const qualityLine = result.info.quality ? `📊 Quality: ${result.info.quality}\n` : '';
    const fileSizeLine = result.info.fileSize ? `💾 Size: ${result.info.fileSize}\n` : '';
    
    const videoOptions = {
      caption: `<a href="tg://user?id=${ctx.from.id}">${senderName}</a> shared: <a href="${url}">Link</a>

<blockquote expandable>👤 ${result.info.author}
⏱ ${result.info.duration}
💾 ${result.info.fileSize}
📱 ${result.info.platform}
${qualityLine}</blockquote>`.trim(),
      parse_mode: 'HTML',
      supports_streaming: true,
      width: result.width,
      height: result.height,
      duration: result.duration
    };
    
    if (thumbnailPath) {
      videoOptions.thumbnail = Input.fromLocalFile(thumbnailPath);
    }
    
    await ctx.replyWithVideo(
      Input.fromLocalFile(result.filePath),
      videoOptions
    );
    
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (error) {
      logger.warn('Could not delete user message (bot might not have permissions)');
    }
    
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
    
    logger.info(`Video sent successfully to ${userInfo}`);
    
  } catch (error) {
    logger.error(`Download failed for ${userInfo}: ${error.message}`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      `❌ ${error.message}\n\n*Troubleshooting:*\n• Ensure link is valid\n• Video must be public\n• Max size: 50MB\n• Platform must be supported`,
      { parse_mode: 'Markdown' }
    );
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
  const userId = ctx.from.id;
  
  // Check if this is a pending YouTube download
  const pendingDownload = pendingYouTubeDownloads.get(messageId);
  
  if (!pendingDownload) {
    await ctx.answerCbQuery('⚠️ This request has expired.');
    await ctx.deleteMessage().catch(() => {});
    return;
  }
  
  // Verify only the original sender can press the buttons
  if (pendingDownload.userId !== userId) {
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
    
    const statusMessage = await ctx.reply('⏳ Processing your request...');
    
    let filePath = null;
    let thumbnailPath = null;
    
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        null,
        '⬇️ Downloading video with yt-dlp...\nThis may take a moment for large videos.'
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
      
      const senderName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
      
      const qualityLine = result.info.quality ? `📊 Quality: ${result.info.quality}\n` : '';
      
      const videoOptions = {
        caption: `<a href="tg://user?id=${ctx.from.id}">${senderName}</a> shared: <a href="${url}">Link</a>

<blockquote expandable>👤 ${result.info.author}
⏱ ${result.info.duration}
💾 ${result.info.fileSize}
📱 ${result.info.platform}
${qualityLine}</blockquote>`.trim(),
        parse_mode: 'HTML',
        supports_streaming: true,
        width: result.width,
        height: result.height,
        duration: result.duration
      };
      
      if (thumbnailPath) {
        videoOptions.thumbnail = Input.fromLocalFile(thumbnailPath);
      }
      
      await ctx.replyWithVideo(
        Input.fromLocalFile(result.filePath),
        videoOptions
      );
      
      // Delete original user message if possible
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, pendingDownload.originalMessageId);
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
        `❌ ${error.message}\n\n*Troubleshooting:*\n• Ensure link is valid\n• Video must be public\n• Max size: 50MB`,
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
}

module.exports = { handleDownload, handleYouTubeCallback };
