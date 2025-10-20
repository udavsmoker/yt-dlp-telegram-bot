const { Markup } = require('telegraf');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

// Track which user opened which settings menu message
const menuOwners = new Map(); // messageId -> userId

async function isAdmin(ctx) {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    
    // In private chats, user is always admin
    if (ctx.chat.type === 'private') {
      return true;
    }
    
    // In groups/supergroups, check if user is admin
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch (error) {
    logger.error('Error checking admin status:', error);
    return false;
  }
}

async function handleSettings(ctx) {
  const userInfo = getUserInfo(ctx);
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  // Check if user is admin
  if (!await isAdmin(ctx)) {
    await ctx.reply('⚠️ Only admins can access settings.');
    return;
  }

  logger.info(`Settings menu opened by ${userInfo} in chat ${chatId}`);

  const settings = settingsService.getSettings(chatId);
  const featureInfo = settingsService.getFeatureInfo();

  // Build inline keyboard with toggle buttons
  const keyboard = [];

  for (const [featureKey, info] of Object.entries(featureInfo)) {
    const isEnabled = settings[featureKey];
    const statusEmoji = isEnabled ? '✅' : '❌';
    const statusText = isEnabled ? 'ON' : 'OFF';
    
    keyboard.push([
      Markup.button.callback(
        `${info.name} - ${statusEmoji} ${statusText}`,
        `toggle_${featureKey}`
      )
    ]);
  }

  // Add close button at the bottom
  keyboard.push([Markup.button.callback('❌ Close', 'settings_close')]);

  const message = `⚙️ *Settings Menu*

Toggle features on/off by tapping the buttons below.
Changes are saved automatically.`;

  try {
    // Delete the command message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn('Could not delete settings command message');
    }
    
    const menuMessage = await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(keyboard).reply_markup
    });
    
    // Track who owns this menu
    menuOwners.set(menuMessage.message_id, userId);
    
    logger.info(`Settings menu message ${menuMessage.message_id} owned by user ${userId}`);
  } catch (error) {
    logger.error('Failed to send settings menu:', error);
    await ctx.reply('❌ Failed to open settings menu. Please try again.');
  }
}

async function handleSettingsCallback(ctx) {
  const userInfo = getUserInfo(ctx);
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const callbackData = ctx.callbackQuery.data;
  const messageId = ctx.callbackQuery.message.message_id;

  logger.info(`Settings callback from ${userInfo}: ${callbackData}`);

  // Check if this user owns this menu
  const menuOwner = menuOwners.get(messageId);
  if (menuOwner && menuOwner !== userId) {
    await ctx.answerCbQuery('⚠️ Only the admin who opened this menu can use these buttons.');
    return;
  }

  try {
    if (callbackData === 'settings_close') {
      // Delete the settings menu and remove from tracking
      menuOwners.delete(messageId);
      await ctx.deleteMessage();
      await ctx.answerCbQuery('Settings menu closed');
      return;
    }

    if (callbackData.startsWith('toggle_')) {
      const featureKey = callbackData.replace('toggle_', '');
      
      // Toggle the feature
      const newValue = await settingsService.toggleFeature(chatId, featureKey);
      const featureInfo = settingsService.getFeatureInfo()[featureKey];
      
      // Update the message with new button states
      const settings = settingsService.getSettings(chatId);
      const allFeatureInfo = settingsService.getFeatureInfo();
      
      const keyboard = [];
      for (const [key, info] of Object.entries(allFeatureInfo)) {
        const isEnabled = settings[key];
        const statusEmoji = isEnabled ? '✅' : '❌';
        const statusText = isEnabled ? 'ON' : 'OFF';
        
        keyboard.push([
          Markup.button.callback(
            `${info.name} - ${statusEmoji} ${statusText}`,
            `toggle_${key}`
          )
        ]);
      }
      keyboard.push([Markup.button.callback('❌ Close', 'settings_close')]);

      const message = `⚙️ *Settings Menu*

Toggle features on/off by tapping the buttons below.
Changes are saved automatically.`;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(keyboard).reply_markup
      });

      // Show notification
      const statusText = newValue ? 'enabled' : 'disabled';
      await ctx.answerCbQuery(`${featureInfo.name} ${statusText}`);
    }
  } catch (error) {
    logger.error('Settings callback error:', error);
    await ctx.answerCbQuery('❌ Error updating settings');
  }
}

module.exports = {
  handleSettings,
  handleSettingsCallback
};
