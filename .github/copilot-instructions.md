# Copilot Instructions for Telegram Video Downloader Bot

## Architecture Overview

This is a **Telegram bot** built with **Telegraf** that downloads videos from 1000+ platforms using **yt-dlp** (via `youtube-dl-exec` npm wrapper) and features AI-powered chat responses using Markov chains.

**Video Download Flow:**
1. User sends URL → `download.handler.js` validates against supported domains, silently ignores non-video URLs
2. **Settings check**: Verifies `videoDownload` feature is enabled for that chat (via `settings.service.js`)
3. **Rate limiting**: In-memory limiter (5 requests/60s per user) - only applied to valid video URLs
4. **TikTok handling**: If TikTok URL, tries regular video download first (more common), falls back to slideshow via `tiktok.service.js` if video fails
5. **Regular videos**: `video.service.js` calls yt-dlp CLI with iOS-optimized format selection
6. **Codec validation**: ffprobe checks for VP9/HEVC, re-encodes to H.264 baseline if needed (iOS compatibility)
7. Video/images downloaded to `temp/` directory (auto-created)
8. Uploaded to Telegram via Telegraf's `replyWithVideo()` or `replyWithMediaGroup()`
9. Temp files cleaned up in `finally` block

**Markov AI Response Flow:**
1. All messages → `markovLearningMiddleware` saves to SQLite database (if feature enabled)
2. Message triggers check → `markovResponseHandler` evaluates based on personality settings
3. Trigger factors: question marks (2x), keyword match (1.5x), silence period (3x), base laziness
4. Response generation → `markov.service.js` builds/uses cached Markov model
5. Response type based on coherence: random messages (0-33), mixed (34-66), Markov-generated (67-100)
6. Context matching for relevant responses, sassiness adds emotional punctuation
7. Human-like delay (2-8s) + typing indicator before sending
8. 30-second cooldown prevents spam

**Meme Generation Flow:**
1. User sends `/meme` command → `meme.handler.js` validates feature enabled
2. **Template loading**: `meme.service.js` loads JSON metadata + image file from `templates/` directory
3. **Message selection**: Queries SQLite for random messages (optionally sassy messages with !, ?)
4. **Canvas rendering**: Draws text on image with configured fonts, colors, alignment, word wrapping
5. **Upload**: Sends rendered image to Telegram via `replyWithPhoto()`
6. Temp files cleaned up, command message deleted
7. **Commands**: `/meme` (random), `/meme <template>` (specific), `/meme list`, `/meme reload` (admin)

**Demotivator Generation Flow:**
1. User sends `/demotivate` or replies to photo with `/demotivate` → `demotivator.handler.js` validates feature
2. **Photo learning**: `photoLearningMiddleware` saves all chat photos to SQLite (max 100 per chat, stores Telegram file_id)
3. **Photo selection**: Gets random photo from database OR uses replied-to photo
4. **Download**: Bot downloads photo from Telegram using file_id
5. **Canvas rendering**: Classic Russian demotivator style - black background, white border, centered image, text below
6. **Message selection**: Random message from chat for demotivator text
7. **Upload**: Sends rendered demotivator to Telegram
8. Temp files cleaned up, command message deleted
9. **Commands**: `/demotivate` (random), `/demotivate` (reply to photo), `/photostats`

**Key Components:**
- `src/index.js` - Bot initialization, middleware chain, graceful shutdown (SIGINT/SIGTERM)
- `src/middleware/index.js` - Custom middleware: logging, error handling
- `src/middleware/markov.middleware.js` - Message learning and smart response triggering
- `src/middleware/photo.middleware.js` - Photo learning for demotivators
- `src/services/video.service.js` - yt-dlp wrapper, format selection, codec compatibility
- `src/services/markov.service.js` - Markov chain response generation, trigger logic
- `src/services/markov-database.service.js` - SQLite database for messages and personality settings
- `src/services/meme.service.js` - Template loading, canvas rendering, message selection for memes
- `src/services/demotivator.service.js` - Russian demotivator generation with canvas
- `src/services/photo-database.service.js` - SQLite storage for photo file_ids (max 100/chat)
- `src/services/settings.service.js` - Per-chat feature toggles (JSON storage in `data/settings.json`)
- `src/services/tiktok.service.js` - TikTok slideshow downloads via `@tobyg74/tiktok-api-dl`
- `src/handlers/*.handler.js` - Command handlers (start, help, about, download, settings, markov, meme, demotivator)
- `src/utils/` - Winston logger (file + console), filesystem helpers, URL validators

## Critical Dependencies

**yt-dlp must be installed separately** via `pip install -U yt-dlp`. The `youtube-dl-exec` package calls the system yt-dlp binary - it doesn't bundle it. Bot exits if yt-dlp is missing.

**NPM Dependencies:**
- `telegraf` - Telegram Bot API framework
- `youtube-dl-exec` - yt-dlp wrapper
- `better-sqlite3` - SQLite database for Markov chains
- `markov-strings` - Markov chain text generation
- `canvas` - Image rendering for meme generation
- `winston` - Logging
- `dotenv` - Environment variables
- `axios` - HTTP requests (TikTok API)
- `@tobyg74/tiktok-api-dl` - TikTok slideshow scraper

**Environment Variables (.env):**
- `BOT_TOKEN` (required) - from @BotFather
- `MAX_FILE_SIZE` (default: 50MB) - Telegram has ~50MB limit for bot uploads
- `TEMP_DIR` (default: `./temp`)
- `WEBHOOK_DOMAIN`, `WEBHOOK_PORT`, `WEBHOOK_PATH` - optional for webhook mode (vs polling)

## Project Conventions

### Error Handling Pattern
All handlers use **try-catch with status message editing**:
```javascript
const statusMessage = await ctx.reply('⏳ Processing...');
try {
  // work
  await ctx.telegram.editMessageText(..., statusMessage.message_id, ...);
} catch (error) {
  await ctx.telegram.editMessageText(..., statusMessage.message_id, `❌ ${error.message}`);
} finally {
  await cleanupFile(filePath); // always cleanup
}
```

### Message Cleanup Pattern
Download handler **deletes user's link message** to reduce clutter, then includes sender's name as clickable link and original URL in video caption. Video info is formatted using Markdown blockquotes (`>` prefix).

### Middleware Chain Order (Critical)
In `src/index.js`, middleware order matters:
1. `errorHandler()` - wraps everything
2. `loggingMiddleware()` - timing + user info
3. `markovLearningMiddleware()` - learns from all messages
4. Command handlers
5. `markovResponseHandler()` - triggers smart AI responses
6. Message handlers (download)
7. **Rate limiter** - applied inside `download.handler.js` (only for valid video URLs, not global)

### Service Pattern
Services are **singletons** (`module.exports = new ServiceName()`). 
- `video.service.js`: All yt-dlp logic centralized, optimized for speed (single call for video+thumbnail)
- `markov.service.js`: Response generation, trigger logic, model caching (10min expiry)
- `markov-database.service.js`: SQLite queries, message storage (max 50k per chat), personality settings

### Logging Strategy
Winston logs to **two files** (`logs/error.log`, `logs/combined.log`) + console in dev mode. All user actions include `getUserInfo()` for tracking: `@username (12345678)`.

## Markov AI Features

### Personality Settings (per chat)
- **Laziness (0-100)**: Controls response frequency. Formula: `trigger_chance = (100 - laziness) / 100 * 0.15`
  - 0 = Very active, responds ~15% of time
  - 50 = Balanced, responds ~7.5% of time
  - 100 = Very lazy, responds ~0% of time (effectively disabled)
- **Coherence (0-100)**: Response type selection
  - 0-33 = Random saved messages
  - 34-66 = Mix of random and Markov-generated
  - 67-100 = Only Markov-generated text
- **Sassiness (0-100)**: Emotional expression level
  - Higher values prefer messages with !, ?, emotional punctuation
  - >70 has 30% chance to add punctuation to responses
- **Markov Order (1-3)**: Chain complexity, default 2
  - Higher = more coherent but needs more data
- **Silence Minutes**: Trigger after X minutes of inactivity, default 15

### Smart Trigger System
Bot responds based on weighted chance:
- **Base**: `(100 - laziness) / 100 * 0.15`
- **Question mark**: 2x multiplier
- **Keyword match**: 1.5x multiplier (checks top 100 frequent words)
- **After silence**: 3x multiplier
- **Cooldown**: 30 seconds between responses (prevents spam)
- **Max chance**: Capped at 90% to keep randomness

### Database Schema
**Messages table**: chat_id, user_id, message_text, reply_to_message_id, timestamp, has_question, has_exclamation, word_count
**Personality settings**: chat_id, laziness, coherence, sassiness, markov_order, silence_minutes
**Cleanup**: Auto-deletes old messages when count exceeds 50k per chat

### Admin Commands
- `/setlaziness <0-100>` - Adjust response frequency
- `/setcoherence <0-100>` - Random vs AI balance
- `/setsassiness <0-100>` - Emotional level
- `/botstats` - Show message count and current settings

## Development Workflows

**Local Development:**
```bash
npm run dev  # nodemon watches src/
```

**Testing a New Platform:**
1. Send URL to bot
2. Check `logs/combined.log` for yt-dlp output
3. If unsupported, yt-dlp error is caught and user-friendly message shown

**Common Issues:**
- **"yt-dlp not found"**: Install via `pip install -U yt-dlp` (not npm)
- **Large videos fail**: Check `MAX_FILE_SIZE` env var (Telegram's bot API limit is ~50MB)
- **Webhook not working**: Requires HTTPS domain, set `WEBHOOK_DOMAIN`

## Key Files to Modify

## Key Files to Modify

- **Add new command**: Create `src/handlers/newcommand.handler.js`, register in `src/index.js`
- **Change quality fallback strategy**: Edit `formatStrategies` array in `video.service.js` (~line 35-55)
- **Add supported platform**: Add domain to `supportedDomains` array in `src/utils/helpers.js`
- **Adjust rate limits**: Modify `rateLimiter(5, 60000)` parameters in `src/index.js`
- **Custom error messages**: Update catch blocks in `video.service.js` (lines 150-160)

## Integration Points

**Telegraf Context (`ctx`):**
- `ctx.from` - user object (id, username)
- `ctx.chat.id` - for editing messages
- `ctx.replyWithVideo()` - Telegram's file upload API (50MB max)

**yt-dlp Output:**
Videos downloaded to `temp/` with naming: `video_<timestamp>_<random>.{mp4|mkv|webm}`. Extension depends on source. Handler searches for any matching extension after download.

**No Database:** All state is in-memory (rate limiter Map). Bot restart clears limits.

**URL Validation:**
Bot only responds to supported video platform URLs (30+ domains in `isValidVideoUrl()` helper). Non-video messages are silently ignored - no error messages sent.

**Pending Updates:**
Bot uses `dropPendingUpdates: true` in polling mode - messages sent while bot was offline are ignored on restart.

**TikTok Slideshows:**
Bot detects TikTok URLs and tries regular video download first (most common case). If video download fails, it falls back to slideshow download via `@tobyg74/tiktok-api-dl`. Slideshows download all images as a media group (audio not included). Uses `replyWithMediaGroup()` for photos.

## Settings System (Admin-Only)

**Access:** `/settings` command (admins only)
**Storage:** `data/settings.json` - per-chat feature toggles
**Pattern:** Scalable system for adding new toggleable features

### Current Features:
- **videoDownload** (boolean) - Controls whether bot downloads videos in that chat
- **markovResponses** (boolean) - AI chat responses using Markov chains
- **memeGeneration** (boolean) - Meme generator using chat messages and templates
- **demotivatorsEnabled** (boolean) - Demotivator generation from chat photos

### Admin Checks:
- In private chats: user is always admin
- In groups/supergroups: checks `creator` or `administrator` status
- Only the admin who opened the menu can use the buttons (tracked via `Map<messageId, userId>`)

### Adding New Features:
1. Add to `defaultSettings` in `settings.service.js`
2. Add to `getFeatureInfo()` with name/description
3. Check with `settingsService.isFeatureEnabled(chatId, 'featureName')` in handlers
4. Button appears automatically in settings menu
