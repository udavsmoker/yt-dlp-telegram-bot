# Telegram Video Downloader Bot

A Telegram bot for downloading videos from varoius platforms using yt-dlp.

## Quick Start

### 1. Install yt-dlp
```bash
pip install -U yt-dlp
```

### 2. Setup Bot
```bash
cp .env.example .env
# Edit .env and add your BOT_TOKEN from @BotFather
```

### 3. Install & Run
```bash
npm install
npm start
```

### 4. (Required for YouTube) Setup PO Token Server

YouTube now requires a Proof-of-Origin (PO) token to download videos. Without it, you'll get 403 Forbidden errors on all formats.

**Install the bgutil PO Token provider:**

```bash
# Install the yt-dlp plugin
pip install -U bgutil-ytdlp-pot-provider

# Clone and build the server
cd ~
git clone --single-branch --branch 1.2.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
cd bgutil-ytdlp-pot-provider/server/
npm install
npx tsc

# Start the server (keep it running in a screen/tmux session)
node build/main.js
```

**Run it in a screen session (recommended):**
```bash
screen -dmS bgutil bash -c 'cd ~/bgutil-ytdlp-pot-provider/server && node build/main.js'
```

The server listens on `http://127.0.0.1:4416` by default. The yt-dlp plugin automatically connects to it.

### 5. (Optional) YouTube Cookies for Higher Quality

For the best quality (720p+), you can also provide browser cookies:
[YouTube PO Token Guide - yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)


**Cookie lifetime:**
- YouTube cookies typically last 1-2 weeks
- Re-export cookies if downloads start failing
- Run `yt-dlp -U` to update yt-dlp monthly

## Features
- 🎬 Support for various platforms (YouTube, TikTok, Instagram, Twitter/X, etc.)
- 🤖 AI chat responses using Markov chains
- 🎨 Meme generator with custom templates
- �️ Russian demotivator creator
- ⚡ Fast downloads with quality fallback
- � iOS-optimized video encoding (H.264)
- 🛡️ Rate limiting (5 requests/minute per user)
- ⚙️ Per-chat feature toggles

## Usage

### Video Downloads
Send any video URL to the bot. Supported platforms include YouTube, TikTok (videos + slideshows), Instagram, Twitter/X, Reddit, Facebook, Vimeo, and more.

### Commands
- `/settings` - Toggle features (admins only)
- `/meme [template]` - Generate meme from chat messages
- `/demotivate` - Create Russian demotivator
- `/setlaziness <0-100>` - Adjust AI response frequency
- `/botstats` - View AI statistics

See [MARKOV_FEATURE.md](MARKOV_FEATURE.md), [MEME_GENERATOR.md](MEME_GENERATOR.md), and [DEMOTIVATOR_FEATURE.md](DEMOTIVATOR_FEATURE.md) for details.

## Requirements
- Node.js 18+
- yt-dlp (installed separately)
- Telegram Bot Token

## Environment Variables
```bash
BOT_TOKEN=your_bot_token_here
MAX_FILE_SIZE=50  # in MB (Telegram limit ~50MB)
TEMP_DIR=./temp
```