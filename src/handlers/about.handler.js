const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleAbout(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`About command from ${userInfo}`);
  
  const aboutMessage = `
ℹ️ *About Video Downloader Bot*

*Version:* 2.0.0 (yt-dlp powered)

This bot downloads videos using the powerful yt-dlp engine.

*Features:*
• High-quality downloads
• Automatic format selection
• Fast and reliable
• Free to use

*Technology:*
• Node.js
• Telegraf
• yt-dlp
• Winston

*Privacy:*
We don't store your videos. All downloads are temporary and deleted after sending.

Made with ❤️ for Telegram
  `;
  
  await ctx.reply(aboutMessage, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
}

module.exports = handleAbout;
