const fs = require('fs').promises;

function extractUrl(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
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
    'streamable.com', 'imgur.com', 'pinterest.com', 'linkedin.com',
    'tumblr.com', 'soundcloud.com', 'bandcamp.com', 'mixcloud.com',
    'vk.com', 'ok.ru', 'bilibili.com', 'nicovideo.jp', 'nico.ms',
    'rutube.ru', 'yandex.ru', 'youku.com', 'douyin.com',
    'snapchat.com', 'likee.video', 'kwai.com', 'triller.co', 'pornhub.com'
  ];
  
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
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

async function isTikTokUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
    return hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com');
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
  isTikTokUrl
};
