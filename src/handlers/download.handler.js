const { Input } = require('telegraf');
const videoService = require('../services/video.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');
const { extractUrl, getUserInfo, cleanupFile, isValidVideoUrl, isTikTokPhotoUrl, isTikTokUrl, isYouTubeUrl, isInstagramUrl, isInstagramPostUrl } = require('../utils/helpers');

const userRequests = new Map();
const MAX_REQUESTS = 5;
const WINDOW_MS = 60000;

const pendingYouTubeDownloads = new Map();

async function handleDownload(ctx, next) {
  const userInfo = getUserInfo(ctx);
  const messageText = ctx.message.text;
  
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
  
  try {
    let isTikTok = isTikTokUrl(url);
    let isInstagramPost = isInstagramPostUrl(url);
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
        
        // If it's actually a video (only videos, no photos), fall back to yt-dlp video download
        if (result.type === 'video' && result.shouldFallback) {
          logger.info('Instagram post contains only video(s), falling back to video download');
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
          
          const senderName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
          
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
              allMedia.push({ type: m.type, path: m.path });
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
              const caption = `<a href="tg://user?id=${ctx.from.id}">${senderName}</a> shared: <a href="${url}">Link</a>\n\n<blockquote expandable>👤 ${result.info.author}\n📱 ${result.info.platform}</blockquote>`.trim();
              
              if (item.type === 'photo') {
                await ctx.replyWithPhoto(
                  Input.fromLocalFile(item.path),
                  { caption, parse_mode: 'HTML' }
                );
              } else {
                await ctx.replyWithVideo(
                  Input.fromLocalFile(item.path),
                  { caption, parse_mode: 'HTML', supports_streaming: true }
                );
              }
            } else {
              const mediaGroup = batch.map((item, index) => ({
                type: item.type,
                media: Input.fromLocalFile(item.path),
                // Only add caption to first item of last batch
                caption: isLastBatch && index === 0 ? `<a href="tg://user?id=${ctx.from.id}">${senderName}</a> shared: <a href="${url}">Link</a>\n\n<blockquote expandable>👤 ${result.info.author}\n📱 ${result.info.platform}</blockquote>`.trim() : undefined,
                parse_mode: isLastBatch && index === 0 ? 'HTML' : undefined,
                ...(item.type === 'video' ? { supports_streaming: true } : {})
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
          
          const senderName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
          
          const videoOptions = {
            caption: `<a href="tg://user?id=${ctx.from.id}">${senderName}</a> shared: <a href="${url}">Link</a>

<blockquote expandable>👤 ${result.info.author}
⏱ ${result.info.duration}
💾 ${result.info.fileSize}
📱 ${result.info.platform}
📊 ${result.info.quality}</blockquote>`.trim(),
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
            '⬇️ Trying yt-dlp fallback...'
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
          
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
          } catch (error) {
            logger.warn('Could not delete user message (bot might not have permissions)');
          }
          
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
          
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
      `❌ ${error.message}\n\n*Troubleshooting:*\n• Ensure link is valid\n• Video must be public\n• Max size: ${ctx.telegram.options?.apiRoot?.includes('localhost') ? '2000' : '50'}MB\n• Platform must be supported`,
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
}

module.exports = { handleDownload, handleYouTubeCallback };
