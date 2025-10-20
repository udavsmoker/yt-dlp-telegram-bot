const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleStart(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Start command from ${userInfo}`);
  
  const welcomeMessage = `
🎬 *Welcome to Video Downloader Bot!*

Powered by *yt-dlp*, I can download videos from 1000+ platforms including:
• TikTok
• YouTube & YouTube Shorts
• Instagram (Posts, Reels, IGTV)
• Twitter/X
• Facebook
• Reddit
• Vimeo
• And many more!

*How to use:*
Just send me a link to any video, and I'll download it for you!

*Commands:*
/start - Show this message
/help - Get help
/about - About this bot

Ready to download? Send me a link! 🚀
  `;
  
  await ctx.reply(welcomeMessage, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
}

module.exports = handleStart;
