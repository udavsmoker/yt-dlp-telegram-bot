const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleStart(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Start command from ${userInfo}`);
  
  const welcomeMessage = `
🎬 *Welcome to Video Downloader Bot!*

Send me a public video link from TikTok, Instagram, YouTube, Twitter or elsewhere, and I'll download it for you! 🚀

For a list of commands, send /help.
  `;
  
  await ctx.reply(welcomeMessage, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
}

module.exports = handleStart;
