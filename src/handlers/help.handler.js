const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleHelp(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Help command from ${userInfo}`);
  
  const helpMessage = `
📖 *How to Use This Bot*

This bot uses *yt-dlp*, which supports 1000+ platforms!

*Popular Platforms:*
✅ TikTok
✅ YouTube & YouTube Shorts
✅ Instagram (Posts, Reels, Stories, IGTV)
✅ Twitter/X
✅ Facebook
✅ Reddit
✅ Vimeo
✅ Twitch
✅ And many more!

*Usage:*
1. Find a video you want to download
2. Copy the link
3. Send it to me
4. Wait for the download
5. Enjoy your video!

*Examples:*
• https://www.tiktok.com/@user/video/123456
• https://youtu.be/abc123
• https://www.instagram.com/reel/xyz789/
• https://twitter.com/user/status/123456

*Tips:*
• Videos must be public
• Max file size: 50MB
• High quality is automatically selected

*Commands:*
/start - Welcome message
/help - This help message
/about - About the bot
/settings - Settings menu (admins only)

*Meme Generator (when enabled):*
/meme - Generate random meme from chat messages
/meme <template> - Generate meme with specific template
/meme list - View available templates
/meme reload - Reload templates (admins only)

*Demotivators (when enabled):*
/demotivate - Create demotivator from random chat photo
/demotivate (reply to photo) - Demotivate specific photo
/photostats - View photo storage statistics

*AI Chat Features (when enabled):*
/setlaziness <0-100> - How often bot responds (admins only)
/setcoherence <0-100> - Random vs AI responses (admins only)
/setsassiness <0-100> - Emotional level (admins only)
/botstats - View message count and settings
  `;
  
  await ctx.reply(helpMessage, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
}

module.exports = handleHelp;
