# yt-dlp-telegram-bot

A Telegram bot that downloads videos from various platforms using `yt-dlp` and includes features like Markov chains and meme generation.

## Setup

1. **Prerequisites**: Node.js 18+ and `yt-dlp`.
   ```bash
   pip install -U yt-dlp
   ```
2. **Environment**:
   Copy `.env.example` to `.env` and fill in your `BOT_TOKEN`.
3. **Run**:
   ```bash
   npm install
   npm start
   ```

## Advanced Configuration

### YouTube PO Token Server
YouTube blocks some downloads with 403 Forbidden without PO tokens.
1. Install plugin: `pip install -U bgutil-ytdlp-pot-provider`
2. Build and run the server locally:
   ```bash
   git clone --single-branch --branch 1.2.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
   cd bgutil-ytdlp-pot-provider/server
   npm install && npx tsc
   node build/main.js --port 4416
   ```

### Cookies
Export a `cookies.txt` file from your browser and place it in the project root to bypass platform restrictions.

## Commands

Core:
- `/start` - Welcome
- `/help` - Command list
- `/about` - Technical details
- `/mp3` - Extract audio (reply to video)
- `/settings` - Bot settings (Admins)

Fun/AI:
- `/meme` - Meme generator
- `/demotivate` - Demotivator generator
- `/botstats` - AI stats
- `/setlaziness`, `/setcoherence`, `/setsassiness` - Markov chain tweaks
