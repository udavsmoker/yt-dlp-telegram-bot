# yt-dlp-telegram-bot

A Telegram bot for downloading videos and music from YouTube, TikTok, Instagram, Spotify, and 1,000+ other sites using `yt-dlp` and `ffmpeg`. Supports file uploads up to 2000MB when paired with a local Telegram Bot API server.

---

## Features

- **Video Downloads**: YouTube (with 1080p / 720p / 480p / audio selector), TikTok (videos & photo slideshows), Instagram (Reels, posts, carousels), Bluesky, Twitter/X, Reddit, and any other site supported by `yt-dlp`.
- **Spotify Downloader**: Downloads tracks, albums, and playlists of any size (>100 tracks paginated automatically). Converted to 320 kbps MP3 with album cover and ID3 tags.
- **Fast Song Search**: Use `/song <title>` (or send any song name directly in private chat). Searches YouTube Music via Innertube API and lets you pick from top 5 results.
- **Download Controls**:
  - `/cancel` — stop active or queued downloads immediately.
  - `/undo` — delete the last media sent by the bot (or reply with `/undo` to a specific bot message).
  - `/mp3` — reply to any video to extract its audio.
- **Large Files (2000MB)**: Works with a local `telegram-bot-api` server to bypass Telegram's default 50MB file size limit.
- **Caching & Queue**: SQLite cache to resend previously downloaded media instantly via `file_id`; concurrent queue with live progress bar.
- **Chat Extras**: Classic demotivators (`/demotivate`), meme generator (`/meme`), and Markov chain AI text generator.

---

## Prerequisites

- **Node.js** 20+
- **ffmpeg** (`sudo apt install ffmpeg`)
- **yt-dlp** (`pip install -U yt-dlp`)
- *(Optional)* [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) running locally for 2000MB uploads instead of 50MB.
- *(Optional)* [bgutil-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) for YouTube Proof-of-Origin tokens (fixes 403 Forbidden).

---

## Setup

```bash
# 1. Clone repository
git clone https://github.com/udav/yt-dlp-telegram-bot.git
cd yt-dlp-telegram-bot

# 2. Install dependencies & rebuild native SQLite module
npm install
npm rebuild better-sqlite3

# 3. Configure environment
cp .env.example .env
# Edit .env with your BOT_TOKEN and settings

# 4. Run tests
npm test

# 5. Start bot
npm start
```

---

## Commands

### Media & Music
- `<link>` — Send any link from YouTube, Spotify, TikTok, Instagram, etc.
- `/song <title>` — Search and download a track *(aliases: `/music`, `/track`, `/find`)*.
- *(Private chat)* — Send any song title as a plain message to search.
- `/mp3` — Extract audio from a video (reply to a video message).

### Controls & Management
- `/cancel` — Stop current download and clear active queue.
- `/undo` — Delete the last media sent by the bot.
- `/settings` — Open chat settings keyboard (Admins only).
- `/health` — Show bot health, queue status, and uptime.
- `/about` — Technical details and engine specifications.
- `/help` — Full command manual.

### Fun & Chat
- `/demotivate` — Create a demotivator (or reply to a photo).
- `/meme [template]` — Generate a meme from chat messages.
- `/meme list` — List available meme templates.
- `/botstats` — Show Markov AI statistics.
- `/setlaziness`, `/setcoherence`, `/setsassiness` — Markov personality settings.

---

## Main Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `BOT_TOKEN` | *required* | Telegram bot token from @BotFather |
| `BOT_API_URL` | `https://api.telegram.org` | Set to `http://localhost:8081` for local Bot API |
| `MAX_FILE_SIZE` | `50` | Max file size in MB (`2000` with local Bot API) |
| `ADMIN_USER_ID` | `0` | Your Telegram user ID |
| `DOWNLOAD_CONCURRENCY` | `4` | Max concurrent video downloads |
| `SPOTIFY_CONCURRENCY` | `3` | Parallel downloads for Spotify playlists |
| `SPOTIFY_MAX_TRACKS` | `1000` | Max tracks allowed per playlist |
| `ENABLE_VIDEO_CACHE` | `true` | Cache Telegram `file_id` in SQLite |
| `CACHE_TTL_HOURS` | `48` | Cache expiration time |
