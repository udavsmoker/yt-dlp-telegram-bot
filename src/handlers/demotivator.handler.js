const demotivatorService = require('../services/demotivator.service');
const photoDb = require('../services/photo-database.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');
const { getUserInfo, cleanupFile } = require('../utils/helpers');
const { Input } = require('telegraf');

async function handleDemotivate(ctx) {
  const userInfo = getUserInfo(ctx);
  let resultPath = null;

  try {
    const isEnabled = await settingsService.isFeatureEnabled(ctx.chat.id, 'demotivatorsEnabled');
    if (!isEnabled) {
      return ctx.reply('❌ Demotivators are disabled. Ask an admin to enable it in /settings.');
    }

    let fileId = null;
    if (ctx.message.reply_to_message && ctx.message.reply_to_message.photo) {
      const replyPhoto = ctx.message.reply_to_message.photo;
      fileId = replyPhoto[replyPhoto.length - 1].file_id;
      logger.info(`Demotivate request from ${userInfo} (reply to photo)`);
    } else {
      const photoCount = photoDb.getPhotoCount(ctx.chat.id);
      if (photoCount === 0) {
        return ctx.reply('❌ No photos available. Send some photos to the chat first, or reply to a photo with /demotivate.');
      }
      logger.info(`Demotivate request from ${userInfo} (random photo)`);
    }

    const statusMessage = await ctx.reply('🎨 Creating demotivator...');

    const result = await demotivatorService.generateDemotivator(
      ctx.chat.id,
      fileId,
      ctx.telegram
    );

    resultPath = result.filePath;

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);

    await ctx.replyWithPhoto(Input.fromLocalFile(resultPath));

    logger.info('Demotivator sent successfully');
  } catch (error) {
    logger.error(`Error in demotivate handler for ${userInfo}: ${error.message}`);
    await ctx.reply(`❌ ${error.message}`);
  } finally {
    if (resultPath) {
      await cleanupFile(resultPath);
    }
  }
}

async function handlePhotoStats(ctx) {
  const userInfo = getUserInfo(ctx);

  try {
    const isEnabled = await settingsService.isFeatureEnabled(ctx.chat.id, 'demotivatorsEnabled');

    const stats = demotivatorService.getPhotoStats(ctx.chat.id);

    let message = '📊 **Photo Statistics**\n\n';
    message += `**Feature Status:** ${isEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
    message += `**Total Photos:** ${stats.totalPhotos}/${stats.maxPhotos}\n`;
    message += `**Storage:** ${((stats.totalPhotos / stats.maxPhotos) * 100).toFixed(1)}% full\n\n`;

    if (stats.recentPhotos.length > 0) {
      message += '**Recent Photos:**\n';
      stats.recentPhotos.forEach((photo, index) => {
        const date = new Date(photo.timestamp);
        message += `${index + 1}. ${date.toLocaleDateString()} - ${photo.width}x${photo.height}`;
        if (photo.has_caption) {
          message += ` (with caption)`;
        }
        message += '\n';
      });
    } else {
      message += '*No photos saved yet.*';
    }

    if (!isEnabled) {
      message += '\n\n⚠️ **Demotivators are disabled!**\nEnable in /settings to start learning photos.';
    } else {
      message += '\n\n💡 Send photos to this chat to use for demotivators!';
    }

    await ctx.reply(message, { parse_mode: 'Markdown' });
    logger.info(`Photo stats request from ${userInfo}`);
  } catch (error) {
    logger.error(`Error in photo stats handler for ${userInfo}: ${error.message}`);
    await ctx.reply(`❌ ${error.message}`);
  }
}

module.exports = { handleDemotivate, handlePhotoStats };
