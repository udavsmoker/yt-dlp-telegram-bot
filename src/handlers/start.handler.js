const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleStart(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Start command from ${userInfo}`);

  const isLocal = ctx.telegram.options?.apiRoot?.includes('localhost');
  const maxSize = isLocal ? '2000MB' : '50MB';

  const welcomeMessage = `👋 <b>Welcome to Media & Music Downloader Bot!</b>

Send me any supported link, and I will deliver the highest quality media directly to Telegram.

📥 <b>Supported Features:</b>
• <b>Videos:</b> YouTube, TikTok, Instagram (Reels, Posts, Carousels), X/Twitter, Bluesky, Reddit, and more (up to ${maxSize})
• <b>Spotify Music:</b> Tracks, Albums, and Playlists in 320 kbps MP3 with embedded album art and ID3 metadata
• <b>Song Search:</b> Type any song title in private chat or use <code>/song &lt;title&gt;</code>
• <b>Audio Extraction & Tagging:</b> <code>/mp3</code>, <code>/tag Title - Artist</code>, <code>/cover</code>
• <b>Media Tools:</b> <code>/cut</code> (trim media), <code>/tts</code> (text to speech), <code>/demotivate</code>

⚡ <b>Quick Controls:</b>
• <code>/cancel</code> — Stop active or queued downloads
• <code>/undo</code> — Delete recently sent media
• <code>/help</code> — View full command list and settings

<i>Just send a link or song name to get started!</i>`;

  await ctx.reply(welcomeMessage, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

module.exports = handleStart;
