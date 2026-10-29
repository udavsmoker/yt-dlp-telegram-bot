const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleAbout(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`About command from ${userInfo}`);

  const isLocal = ctx.telegram.options?.apiRoot?.includes('localhost');
  const maxSize = isLocal ? '2000MB' : '50MB';

  const aboutMessage = `ℹ️ <b>About Media & Music Downloader Bot</b>

<b>Architecture & Engines:</b>
• <b>Video Engine:</b> <code>yt-dlp</code> with specialized multi-platform fallback pipelines (TikTok API/slideshows, Instagram Graph/proxy, Bluesky AT Protocol)
• <b>Music Pipeline:</b> YouTube Music Innertube search engine, yt-dlp audio extractor & FFmpeg audio transcoder
• <b>Metadata Engine:</b> ID3v2.3 tagging with high-res embedded album artwork
• <b>Queue & Delivery:</b> Concurrency-controlled sliding-window queue with throttled real-time progress bars
• <b>Telegram Backend:</b> Local Telegram Bot API server (max payload: <b>${maxSize}</b>)

<b>Privacy & Storage:</b>
• Media files are strictly transient: processed in temporary storage and cleaned up immediately upon delivery
• SQLite caching (WAL mode) only stores Telegram <code>file_id</code> handles for rapid re-sending without storing media files on disk

Made with ❤️ for Telegram`;

  await ctx.reply(aboutMessage, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

module.exports = handleAbout;
