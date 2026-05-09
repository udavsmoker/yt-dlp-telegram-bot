# Telegram Video Downloader & Utility Bot

A feature-rich, high-performance Telegram bot for downloading media from various platforms using `yt-dlp`, coupled with interactive chat enhancements like Markov chain AI, meme generation, and Russian demotivators.

## ✨ Features

- 🎬 **Universal Media Downloader**: Support for 1000+ platforms including YouTube, TikTok (videos & slideshows), Instagram (Posts, Reels, IGTV), Twitter/X, Facebook, Reddit, and Vimeo.
- 🚦 **Smart Fallback System**: Automatically rotates through format qualities and native APIs to ensure successful downloads.
- 🧼 **Clean User Interface**: Technical `yt-dlp` errors and logs are parsed and stripped of jargon, presenting users with clear, actionable status messages.
- 📱 **Mobile Optimized**: Automatically ensures iOS-compatible video encoding (H.264).
- 🤖 **Markov Chain AI**: Generates context-aware, entertaining AI responses based on chat history.
- 🎨 **Image Generators**: Integrated Meme generator using custom templates and a classic Russian Demotivator creator.
- 🛡️ **Security & Rate Limiting**: Built-in protections limiting users to 5 requests per minute, plus per-chat feature toggles via the `/settings` interface.

## 🚀 Quick Start

### 1. Prerequisites
Ensure you have **Node.js 18+** installed. `yt-dlp` must be installed natively on the system.
```bash
pip install -U yt-dlp
```

### 2. Setup Bot
```bash
cp .env.example .env
# Edit .env and supply your BOT_TOKEN from @BotFather
```

### 3. Install & Run
```bash
npm install
npm start
```

## 🛠️ Advanced Configuration

### YouTube PO Token Server (Required for YouTube)
YouTube now requires a Proof-of-Origin (PO) token to download videos, otherwise requests will return `403 Forbidden`.

1. **Install the yt-dlp plugin**:
```bash
pip install -U bgutil-ytdlp-pot-provider
```
2. **Clone and build the server**:
```bash
cd ~
git clone --single-branch --branch 1.2.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
cd bgutil-ytdlp-pot-provider/server/
npm install
npx tsc
```
3. **Run the server in a background session**:
```bash
screen -dmS bgutil bash -c 'cd ~/bgutil-ytdlp-pot-provider/server && node build/main.js'
```
*The server listens on `http://127.0.0.1:4416` by default. The `yt-dlp` plugin automatically connects to it.*

### Instagram & Platform Cookies
For higher quality downloads and bypassing platform-specific rate limits (e.g., Instagram login walls), you can provide browser cookies:
1. Export a `cookies.txt` file from your browser.
2. Place it in the root directory of this repository. The bot will automatically detect and apply it during downloads.

## 📱 Bot Commands

**Core:**
- `/start` - Welcome message
- `/help` - View command list
- `/about` - Technical details about the bot
- `/settings` - Configure feature toggles (Admins only)

**Fun & Image Generation:**
- `/meme [template]` - Generate a meme using chat history
- `/meme list` - List available templates
- `/demotivate` - Create a Russian demotivator (or reply to an image)
- `/photostats` - Storage capacity details

**AI & Chat Moderation (Admins):**
- `/setlaziness <0-100>` - Adjust AI response frequency
- `/setcoherence <0-100>` - Balance between random & AI-generated responses
- `/setsassiness <0-100>` - Adjust response tone/emotion
- `/botstats` - View current chat analytics

## 📚 Documentation

For deep-dives into specific features and architectures, please see our dedicated documentation folder:
- [Markov Chat AI](docs/MARKOV_FEATURE.md)
- [Meme Generator](docs/MEME_GENERATOR.md)
- [Demotivators](docs/DEMOTIVATOR_FEATURE.md)
- [Multi-Image Support](docs/MULTI_IMAGE_FEATURE.md)
- [Settings & Admin Architecture](docs/SETTINGS.md)

---
*Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp)*
