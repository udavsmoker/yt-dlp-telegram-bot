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
  return `@${user.username || 'unknown'} (${user.id})`;
}

function isValidVideoUrl(url) {
  const supportedDomains = [
    'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com',
    'twitter.com', 'x.com', 'facebook.com', 'fb.watch',
    'reddit.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv',
    'streamable.com', 'soundcloud.com', 'bandcamp.com',
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
    return path.includes('/p/');
  } catch {
    return false;
  }
}

module.exports = {
  extractUrl,
  ensureDir,
  cleanupFile,
  generateFilename,
  getUserInfo,
  isValidVideoUrl,
  isTikTokPhotoUrl,
  isTikTokUrl,
  isYouTubeUrl,
  isInstagramUrl,
  isInstagramPostUrl
};
