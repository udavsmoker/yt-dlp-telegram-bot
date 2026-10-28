const fs = require('fs').promises;
const path = require('path');

// Load extra domains from local config (gitignored)
let localConfig = { extraDomains: [], hlsPatterns: [], problematicPatterns: [] };
try {
  const configPath = path.join(__dirname, '../../local-domains.json');
  localConfig = require(configPath);
} catch (e) {
  // Local config doesn't exist, that's fine
}

function extractUrl(text) {
  if (!text || typeof text !== 'string') return null;

  // Basic URL-like pattern, stops at whitespace or closing characters
  const urlRegex = /(https?:\/\/[^\s>"')]+)/i;
  const match = text.match(urlRegex);
  if (!match) return null;

  let url = match[0];

  // Trim common trailing punctuation that users may include
  url = url.replace(/[),.;!?]+$/g, '');

  try {
    const urlObj = new URL(url);

    // Reject URLs without a dot in hostname (likely malformed)
    if (!urlObj.hostname.includes('.')) {
      return null;
    }

    // Explicitly ignore extremely long query strings to avoid pathological cases
    if (urlObj.search && urlObj.search.length > 1024) {
      return null;
    }

    return urlObj.toString();
  } catch {
    return null;
  }
}

async function ensureDir(dirPath) {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

async function cleanupFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
  }
}

function generateFilename(prefix, extension) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}.${extension}`;
}

function getUserInfo(ctx) {
  const user = ctx.from;
  if (user) {
    return `@${user.username || 'unknown'} (${user.id})`;
  }
  // Channel posts have no ctx.from — use chat info instead
  const chat = ctx.chat;
  if (chat) {
    return `channel "${chat.title || 'unknown'}" (${chat.id})`;
  }
  return 'unknown source';
}

function isValidVideoUrl(url) {
  const supportedDomains = [
    'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com',
    'twitter.com', 'x.com', 'facebook.com', 'fb.watch',
    'reddit.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv',
    'streamable.com', 'soundcloud.com', 'bandcamp.com',
    'bsky.app', 'spotify.com', 'spotify.link',
    // Extra domains loaded from local-domains.json (gitignored)
    ...(localConfig.extraDomains || [])
  ];
  
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
    // Reject URLs with @ in query/hash (phishing attempts like youtube.com/?@evil.com)
    if (urlObj.search.includes('@') || urlObj.hash.includes('@')) {
      return false;
    }
    
    // Strict YouTube URL validation
    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      // YouTube URLs must have either:
      // - /watch?v= (standard videos)
      // - /shorts/ (shorts)
      // - /live/ (live streams)
      // - /embed/ (embeds)
      // Reject bare domain or suspicious patterns
      const path = urlObj.pathname.toLowerCase();
      const hasVideoId = urlObj.searchParams.has('v');
      const validPath = path.includes('/watch') || path.includes('/shorts/') || 
                       path.includes('/live/') || path.includes('/embed/');
      
      if (!hasVideoId && !validPath) {
        return false;
      }
    }
    
    // youtu.be must have a path (video ID)
    if (hostname === 'youtu.be' && urlObj.pathname.length <= 1) {
      return false;
    }
    
    return supportedDomains.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

function isTikTokPhotoUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
    return (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) && 
           urlObj.pathname.includes('/photo/');
  } catch {
    return false;
  }
}

function isTikTokUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
    return hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com');
  } catch {
    return false;
  }
}

function isYouTubeUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
    return hostname === 'youtube.com' || 
           hostname.endsWith('.youtube.com') || 
           hostname === 'youtu.be';
  } catch {
    return false;
  }
}

function isInstagramUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
    return hostname === 'instagram.com' || hostname.endsWith('.instagram.com');
  } catch {
    return false;
  }
}

function isInstagramPostUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
    if (hostname !== 'instagram.com' && !hostname.endsWith('.instagram.com')) {
      return false;
    }
    
    const path = urlObj.pathname.toLowerCase();
    // Instagram posts use /p/ path, reels use /reel/ or /reels/
    return path.includes('/p/') || path.includes('/reel/') || path.includes('/reels/');
  } catch {
    return false;
  }
}

function getInstagramImgIndex(url) {
  try {
    const urlObj = new URL(url);
    const imgIndex = urlObj.searchParams.get('img_index');
    if (imgIndex) {
      const index = parseInt(imgIndex, 10);
      if (!isNaN(index) && index >= 1) return index;
    }
    return null;
  } catch {
    return null;
  }
}

function isBlueskyUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    return hostname === 'bsky.app';
  } catch {
    return false;
  }
}

function isBlueskyPostUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    if (hostname !== 'bsky.app') return false;
    // Must match /profile/<actor>/post/<rkey>
    return /^\/profile\/[^/]+\/post\/[^/]+/.test(urlObj.pathname);
  } catch {
    return false;
  }
}

const { Input } = require('telegraf');
const config = require('../config');

/**
 * Prepare a thumbnail image to meet Telegram Bot API requirements:
 * - JPEG format
 * - Max 320px on longest side (preserving aspect ratio)
 * - Max 200KB file size
 * 
 * @param {string} inputPath - Path to input image (any format ffmpeg supports)
 * @param {string} [outputPath] - Optional output path. If not provided, generates one.
 * @returns {Promise<string|null>} Path to prepared thumbnail, or null on failure
 */
async function prepareThumbnail(inputPath, outputPath = null) {
  try {
    const { execFileSync } = require('child_process');
    
    if (!outputPath) {
      outputPath = path.join(
        config.download.tempDir,
        generateFilename('thumb_prepared', 'jpg')
      );
    }
    
    // Scale to max 320px on longest side, convert to JPEG
    // Use q:v 5 initially (good quality, small size)
    execFileSync('ffmpeg', [
      '-y', '-i', inputPath,
      '-vf', "scale='if(gt(iw,ih),min(320,iw),-2)':'if(gt(iw,ih),-2,min(320,ih))'",
      '-frames:v', '1',
      '-q:v', '5',
      outputPath
    ], { stdio: 'ignore', timeout: 10000 });
    
    // Check file size - must be under 200KB
    const stats = await fs.stat(outputPath);
    
    if (stats.size > 200 * 1024) {
      // Re-encode with lower quality to fit under 200KB
      const tempPath = outputPath + '.tmp.jpg';
      execFileSync('ffmpeg', [
        '-y', '-i', outputPath,
        '-q:v', '10',
        tempPath
      ], { stdio: 'ignore', timeout: 10000 });
      await fs.unlink(outputPath);
      await fs.rename(tempPath, outputPath);
      
      const newStats = await fs.stat(outputPath);
      if (newStats.size > 200 * 1024) {
        // Still too large - try even lower quality with forced smaller size
        const tempPath2 = outputPath + '.tmp2.jpg';
        execFileSync('ffmpeg', [
          '-y', '-i', outputPath,
          '-vf', "scale='if(gt(iw,ih),min(200,iw),-2)':'if(gt(iw,ih),-2,min(200,ih))'",
          '-q:v', '12',
          tempPath2
        ], { stdio: 'ignore', timeout: 10000 });
        await fs.unlink(outputPath);
        await fs.rename(tempPath2, outputPath);
      }
    }
    
    const finalStats = await fs.stat(outputPath);
    const logger = require('./logger');
    logger.info(`Thumbnail prepared: ${finalStats.size} bytes, path: ${path.basename(outputPath)}`);
    
    return outputPath;
  } catch (error) {
    const logger = require('./logger');
    logger.warn(`Failed to prepare thumbnail: ${error.message}`);
    // Clean up on failure
    try { await fs.unlink(outputPath); } catch {}
    return null;
  }
}

/**
 * Generate a thumbnail from a video file, meeting Telegram requirements.
 * Uses ffmpeg thumbnail filter to select the most representative frame.
 * 
 * @param {string} videoPath - Path to the video file
 * @param {string} [outputPath] - Optional output path
 * @returns {Promise<string|null>} Path to prepared thumbnail, or null on failure
 */
async function generateThumbnailFromVideo(videoPath, outputPath = null) {
  try {
    const { execFileSync } = require('child_process');
    
    if (!outputPath) {
      outputPath = path.join(
        config.download.tempDir,
        generateFilename('thumb_gen', 'jpg')
      );
    }
    
    // Use thumbnail filter to pick the best frame, then scale to max 320px
    execFileSync('ffmpeg', [
      '-y', '-i', videoPath,
      '-vf', "thumbnail,scale='if(gt(iw,ih),min(320,iw),-2)':'if(gt(iw,ih),-2,min(320,ih))'",
      '-frames:v', '1',
      '-q:v', '5',
      outputPath
    ], { stdio: 'ignore', timeout: 15000 });
    
    // Verify it was created
    await fs.access(outputPath);
    
    // Check size and re-encode if needed
    const stats = await fs.stat(outputPath);
    if (stats.size > 200 * 1024) {
      const tempPath = outputPath + '.tmp.jpg';
      execFileSync('ffmpeg', [
        '-y', '-i', outputPath,
        '-q:v', '10',
        tempPath
      ], { stdio: 'ignore', timeout: 10000 });
      await fs.unlink(outputPath);
      await fs.rename(tempPath, outputPath);
    }
    
    const finalStats = await fs.stat(outputPath);
    const logger = require('./logger');
    logger.info(`Video thumbnail generated: ${finalStats.size} bytes, path: ${path.basename(outputPath)}`);
    
    return outputPath;
  } catch (error) {
    const logger = require('./logger');
    logger.warn(`Failed to generate thumbnail from video: ${error.message}`);
    try { await fs.unlink(outputPath); } catch {}
    return null;
  }
}

function getFileForTelegram(filePath) {
  if (config.botApiUrl && (config.botApiUrl.includes('localhost') || config.botApiUrl.includes('127.0.0.1'))) {
    return 'file://' + path.resolve(filePath);
  }
  return Input.fromLocalFile(filePath);
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return 'Unknown';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i === 0) return `${bytes} ${sizes[i]}`;
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return 'Unknown';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Periodically clean up files older than maxAgeMs from the given directory.
 * Only deletes files (not directories). Runs on an interval.
 * @param {string} dirPath - Directory to clean
 * @param {number} maxAgeMs - Max file age in milliseconds (default: 30 minutes)
 * @param {number} intervalMs - Cleanup interval in milliseconds (default: 10 minutes)
 */
function startTempCleanup(dirPath, maxAgeMs = 30 * 60 * 1000, intervalMs = 10 * 60 * 1000) {
  const logger = require('./logger');

  const cleanup = async () => {
    try {
      const files = await fs.readdir(dirPath);
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        try {
          const filePath = path.join(dirPath, file);
          const stat = await fs.stat(filePath);
          if (stat.isFile() && (now - stat.mtimeMs) > maxAgeMs) {
            await fs.unlink(filePath);
            cleaned++;
          }
        } catch {
          // File may have been deleted by another process, ignore
        }
      }

      if (cleaned > 0) {
        logger.info(`Temp cleanup: removed ${cleaned} stale file(s) from ${dirPath}`);
      }
    } catch (error) {
      logger.warn(`Temp cleanup error: ${error.message}`);
    }
  };

  // Run once on start, then on interval
  cleanup();
  setInterval(cleanup, intervalMs);
}

/**
 * Format a visual progress bar with speed and ETA.
 */
function renderProgressBar(percent, speed, eta) {
  const totalBars = 10;
  const clamped = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const filled = Math.round((clamped / 100) * totalBars);
  const empty = totalBars - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  const lines = [`⬇️ Downloading: [${bar}] ${clamped}%`];
  if (speed && !['Unknown B/s', '---b/s', 'N/A', 'NA'].includes(speed.trim())) {
    lines.push(`Speed: ${speed.trim()}`);
  }
  if (eta && !['Unknown', '--:--', 'NA', 'N/A'].includes(eta.trim())) {
    lines.push(`⏱ ETA: ${eta.trim()}`);
  }
  return lines.join('\n');
}

/**
 * Check if the user is an administrator or creator of the chat.
 * @param {object} ctx - Telegraf context
 * @returns {Promise<boolean>}
 */
async function isAdmin(ctx) {
  try {
    const chatType = ctx.chat?.type;
    if (chatType === 'private' || chatType === 'channel') {
      return true;
    }
    const userId = ctx.from?.id;
    if (!userId) return false;
    const member = await ctx.getChatMember(userId);
    return member.status === 'creator' || member.status === 'administrator';
  } catch {
    return false;
  }
}

/**
 * Escape HTML special characters for Telegram HTML parse_mode.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  escapeHtml,
  extractUrl,
  ensureDir,
  cleanupFile,
  generateFilename,
  getUserInfo,
  getFileForTelegram,
  prepareThumbnail,
  generateThumbnailFromVideo,
  isValidVideoUrl,
  isTikTokPhotoUrl,
  isTikTokUrl,
  isYouTubeUrl,
  isInstagramUrl,
  isInstagramPostUrl,
  getInstagramImgIndex,
  isBlueskyUrl,
  isBlueskyPostUrl,
  formatFileSize,
  formatDuration,
  renderProgressBar,
  isAdmin,
  startTempCleanup
};

