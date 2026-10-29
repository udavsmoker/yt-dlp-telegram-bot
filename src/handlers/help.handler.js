const logger = require('../utils/logger');
const { getUserInfo } = require('../utils/helpers');

async function handleHelp(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Help command from ${userInfo}`);

  const isLocal = ctx.telegram.options?.apiRoot?.includes('localhost');
  const maxSize = isLocal ? '2000MB' : '50MB';

  const helpMessage = `📖 <b>Bot Command Center</b>

<b>📥 Media & Music Downloads:</b>
• <b>Send any link:</b> Automatically downloads video or Spotify audio
• <code>/song &lt;title&gt;</code> — Search and download music directly <i>(aliases: /music, /track, /search)</i>
• <i>In private chat:</i> send any song name without commands to search
• <code>/mp3</code> — Extract audio from a video (reply to any video message)
• <code>/tag &lt;title&gt; - &lt;artist&gt;</code> — Change title, artist, and cover art (reply to audio)
• <code>/cover</code> — Update cover art (reply with photo to audio)
• <code>/cut &lt;start&gt; &lt;end&gt;</code> — Trim video or audio (e.g. <code>/cut 0:15 1:30</code>)
• <code>/tts &lt;text&gt;</code> — Voice text or replied message into a voice note

<b>⚡ Queue & Process Control:</b>
• <code>/cancel</code> — Stop active/queued download or cancel selection menu
• <code>/undo</code> — Delete last bot-sent media (or reply to a bot message with /undo)

<b>⚙️ Chat & Diagnostics:</b>
• <code>/settings</code> — Interactive chat settings & feature toggles (Admins)
• <code>/health</code> — Check service status, queue state & diagnostics
• <code>/about</code> — View bot engine and technical specs

<b>🎉 Entertainment (if enabled in /settings):</b>
• <code>/demotivate [title | subtitle]</code> — Create demotivator with custom or random text
• <code>/meme [template]</code> — Generate a meme from chat messages
• <code>/meme list</code> — List available meme templates
• <code>/photostats</code> — View chat photo storage statistics
• <code>/botstats</code> — View Markov AI generation stats
• <code>/setlaziness</code>, <code>/setcoherence</code>, <code>/setsassiness</code> — Tweak Markov AI personality (Admins)

<b>ℹ️ Specifications:</b>
• Max file size: <b>${maxSize}</b>
• Audio format: <b>320 kbps MP3</b> with embedded ID3v2.3 tags & cover art`;

  await ctx.reply(helpMessage, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

module.exports = handleHelp;
