const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleStart(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Start command from ${userInfo}`);

  const rawText = ctx.message?.text || '';
  const parts = rawText.trim().split(/\s+/);
  const payload = parts.length > 1 ? parts[1].trim() : null;

  // Handle inline mode deep-links (<= 64 chars)
  if (payload) {
    const { handleDownload } = require('./download');

    if (payload.startsWith('s_')) {
      const inlineService = require('../services/inline.service');
      const targetUrl = inlineService.getShortLink(payload);
      if (targetUrl) {
        ctx.message.text = targetUrl;
        return handleDownload(ctx, () => {});
      }
    }

    if (payload.startsWith('song_')) {
      const youtubeId = payload.replace('song_', '');
      ctx.message.text = `https://www.youtube.com/watch?v=${youtubeId}`;
      return handleDownload(ctx, () => {});
    }

    if (payload.startsWith('dl_') || payload.startsWith('mp3_')) {
      try {
        const cleanPayload = payload.replace(/^(?:dl|mp3)_/, '');
        const decodedUrl = Buffer.from(cleanPayload, 'base64url').toString('utf8');
        ctx.message.text = decodedUrl;
        return handleDownload(ctx, () => {});
      } catch (err) {
        logger.warn(`Failed to decode start deep-link payload "${payload}": ${err.message}`);
      }
    }
  }

  const isLocal = ctx.telegram.options?.apiRoot?.includes('localhost');
  const maxSize = isLocal ? '2000MB' : '50MB';

  const welcomeMessage = `👋 <b>Welcome to Media & Music Downloader Bot!</b>

Send me any supported link, and I will deliver the highest quality media directly to Telegram.

📥 <b>Supported Features:</b>
• <b>Videos:</b> YouTube, TikTok, Instagram (Reels, Posts, Carousels), X/Twitter, Bluesky, Reddit, and more (up to ${maxSize})
• <b>Spotify Music:</b> Tracks, Albums, and Playlists in 320 kbps MP3 with embedded album art and ID3 metadata
• <b>Inline Mode:</b> Type <code>@${ctx.botInfo?.username || 'bot'}</code> in any chat to share videos or search songs!
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
