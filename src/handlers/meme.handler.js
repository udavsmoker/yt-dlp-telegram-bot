const memeService = require('../services/meme.service');
const settingsService = require('../services/settings.service');
const markovDb = require('../services/markov-database.service');
const logger = require('../utils/logger');
const { getUserInfo, cleanupFile } = require('../utils/helpers');
const { Input } = require('telegraf');

async function handleMeme(ctx) {
  const userInfo = getUserInfo(ctx);
  
  try {
    const isEnabled = await settingsService.isFeatureEnabled(ctx.chat.id, 'memeGeneration');
    if (!isEnabled) {
      return ctx.reply('❌ Meme generation is disabled. Ask an admin to enable it in /settings.');
    }

    const args = ctx.message.text.split(' ').slice(1);
    const command = args[0]?.toLowerCase();

    if (command === 'list') {
      const templates = memeService.getTemplateList();
      
      if (templates.length === 0) {
        return ctx.reply('❌ No templates available. Add template images and JSON files to the templates/ directory.');
      }

      let message = '📋 *Available Meme Templates:*\n\n';
      templates.forEach(t => {
        message += `• *${t.name}*\n`;
        message += `  ${t.description}\n`;
        message += `  Text boxes: ${t.textBoxCount}\n\n`;
      });
      message += 'Use /meme for random or /meme <name> for specific template.';

      return ctx.reply(message, { parse_mode: 'Markdown' });
    }

    if (command === 'reload') {
      const CREATOR_ID = 440493817;
      
      if (ctx.from.id !== CREATOR_ID) {
        return ctx.reply('❌ Only the bot creator can reload templates.');
      }

      const count = await memeService.reloadTemplates();
      return ctx.reply(`✅ Reloaded ${count} template(s).`);
    }

    const messageCount = markovDb.getMessageCount(ctx.chat.id);
    if (messageCount < 10) {
      return ctx.reply(`❌ Not enough messages to generate meme. Need at least 10 messages, currently have ${messageCount}.`);
    }

    const statusMessage = await ctx.reply('🎨 Generating meme...');

    logger.info(`Meme generation request from ${userInfo}, template: ${command || 'random'}`);

    const templateName = command && command !== 'list' && command !== 'reload' ? command : null;
    const result = await memeService.generateMeme(ctx.chat.id, templateName);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      null,
      '📤 Uploading meme...'
    );

    await ctx.replyWithPhoto(
      Input.fromLocalFile(result.filePath),
      {
        caption: `Template: ${result.templateName}`
      }
    );

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);

    await cleanupFile(result.filePath);

    logger.info(`Meme sent successfully using template ${result.templateName}`);
  } catch (error) {
    logger.error(`Error in meme handler for ${userInfo}: ${error.message}`);
    await ctx.reply(`❌ ${error.message}`);
  }
}

module.exports = handleMeme;
