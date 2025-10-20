const { Input } = require('telegraf');
const videoService = require('../services/video.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');
const { extractUrl, getUserInfo, cleanupFile, isValidVideoUrl, isTikTokPhotoUrl, isTikTokUrl } = require('../utils/helpers');

const userRequests = new Map();
const MAX_REQUESTS = 5;
const WINDOW_MS = 60000;

async function handleDownload(ctx) {
  const userInfo = getUserInfo(ctx);
  const messageText = ctx.message.text;
  
  const url = extractUrl(messageText);
  
  if (!url || !isValidVideoUrl(url)) {
    return;
  }

  const chatId = ctx.chat.id;
  if (!settingsService.isFeatureEnabled(chatId, 'videoDownload')) {
    logger.info(`Video download disabled for chat ${chatId}, ignoring URL`);
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

module.exports = handleDownload;
