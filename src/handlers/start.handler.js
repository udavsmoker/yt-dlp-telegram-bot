const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleStart(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Start command from ${userInfo}`);
  
  const welcomeMessage = `
Hi. I'm a video downloader bot.

Send me a link from YouTube, TikTok, Instagram, Twitter, Reddit, or elsewhere, and I'll download it.
Use /help to see available commands.
  `;
  
  await ctx.reply(welcomeMessage, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
}

module.exports = handleStart;
