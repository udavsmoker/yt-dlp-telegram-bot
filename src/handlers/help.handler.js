const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleHelp(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Help command from ${userInfo}`);
  
  const helpMessage = `
📖 *Help*

Send me any public video link and I'll download it. Max size is 50MB.

*Core commands:*
/start - Welcome
/help - Help
/about - About bot
/settings - Chat settings (Admins)
/botstats - View AI stats

*Memes & Fun (if enabled):*
/meme - Random meme
/meme list - View templates
/demotivate - Random demotivator (or reply to a photo)
/photostats - Photo storage info

*AI settings (Admins):*
/setlaziness <0-100>
/setcoherence <0-100>
/setsassiness <0-100>
  `;
  
  await ctx.reply(helpMessage, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
}

module.exports = handleHelp;
