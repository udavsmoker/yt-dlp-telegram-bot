const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleHelp(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Help command from ${userInfo}`);
  
  const isLocal = ctx.telegram.options?.apiRoot?.includes('localhost');
  const maxSize = isLocal ? '2000MB' : '50MB';

  const helpMessage = `
*Commands:*
/start - welcome message
/help - this message
/about - technical details
/mp3 - extract audio from a replied video
/settings - chat settings (Admins)
/botstats - view AI stats

*Fun (if enabled):*
/meme [template] - generate a meme
/meme list - available templates
/demotivate - create a demotivator (or reply to a photo)
/photostats - photo storage info

*AI settings (Admins):*
/setlaziness <0-100>
/setcoherence <0-100>
/setsassiness <0-100>

*Usage:*
Just send a valid video link.
Max size: ${maxSize}.
  `;
  
  await ctx.reply(helpMessage, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
}

module.exports = handleHelp;
