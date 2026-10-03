const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { generateFilename, ensureDir, generateThumbnailFromVideo } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');

const BSKY_PUBLIC_API = 'https://public.api.bsky.app/xrpc';
const BSKY_PDS_API = 'https://bsky.social/xrpc';

class BlueskyService {
  /**
   * Parse a bsky.app URL into its components.
   * Supports:
   *   https://bsky.app/profile/<handle_or_did>/post/<rkey>
   * @returns {{ actor: string, rkey: string } | null}
   */
  parseBlueskyUrl(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase().replace('www.', '');

      if (hostname !== 'bsky.app') return null;

      // /profile/<actor>/post/<rkey>
      const match = urlObj.pathname.match(/^\/profile\/([^/]+)\/post\/([^/]+)/);
      if (!match) return null;

      return { actor: match[1], rkey: match[2] };
    } catch {
      return null;
    }
  }

  /**
   * Resolve a Bluesky handle to a DID.
   * If the actor is already a DID (starts with "did:"), returns it as-is.
   */
  async resolveHandle(actor) {
    if (actor.startsWith('did:')) return actor;

    const res = await axios.get(`${BSKY_PUBLIC_API}/com.atproto.identity.resolveHandle`, {
      params: { handle: actor },
      timeout: 8000
    });

    if (!res.data?.did) {
      throw new Error(`Could not resolve Bluesky handle: ${actor}`);
    }

    return res.data.did;
  }

  /**
   * Fetch post data from the public API.
   * Returns the thread post view (includes resolved embed URLs).
   */
  async getPost(did, rkey) {
    const atUri = `at://${did}/app.bsky.feed.post/${rkey}`;

    const res = await axios.get(`${BSKY_PUBLIC_API}/app.bsky.feed.getPostThread`, {
      params: { uri: atUri, depth: 0 },
      timeout: 10000
    });

    if (!res.data?.thread?.post) {
      throw new Error('Post not found or thread blocked');
    }

    return res.data.thread.post;
  }

  /**
   * Main entry point: download content from a Bluesky post URL.
   * Returns a result object compatible with the download handler
   * (same shape as TikTok/Instagram services).
   */
  async downloadBlueskyPost(url) {
    try {
      logger.info(`Downloading Bluesky post: ${url}`);
      await ensureDir(config.download.tempDir);

      const parsed = this.parseBlueskyUrl(url);
      if (!parsed) throw new Error('Invalid Bluesky URL');

      const did = await this.resolveHandle(parsed.actor);
      const post = await this.getPost(did, parsed.rkey);

      const author = post.author?.displayName || post.author?.handle || 'Unknown';
      const postText = post.record?.text || '';
      const embedType = post.embed?.$type || '';

      logger.info(`Bluesky post by "${author}", embed type: ${embedType || 'none'}`);

      // Video post
      if (embedType === 'app.bsky.embed.video#view') {
        return await this._downloadVideo(post, did, author, postText);
      }

      // Image post
      if (embedType === 'app.bsky.embed.images#view') {
        return await this._downloadImages(post, author, postText);
      }

      // Record with media (quote post with images/video)
      if (embedType === 'app.bsky.embed.recordWithMedia#view') {
        const innerEmbed = post.embed?.media;
        if (innerEmbed?.$type === 'app.bsky.embed.video#view') {
          // Substitute inner embed as the post embed for download
          const modifiedPost = { ...post, embed: innerEmbed };
          return await this._downloadVideo(modifiedPost, did, author, postText);
        }
        if (innerEmbed?.$type === 'app.bsky.embed.images#view') {
          const modifiedPost = { ...post, embed: innerEmbed };
          return await this._downloadImages(modifiedPost, author, postText);
        }
      }

      // External link embed — nothing meaningful to download
      if (embedType === 'app.bsky.embed.external#view') {
        throw new Error('This Bluesky post contains a link card, not downloadable media');
      }

      // Text-only post
      if (!embedType) {
        throw new Error('This Bluesky post contains only text, no media to download');
      }

      throw new Error(`Unsupported Bluesky embed type: ${embedType}`);
    } catch (error) {
      logger.error(`Bluesky download error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download video from a Bluesky post.
   * Primary: direct blob download (original MP4, best quality).
   * The blob CID comes from the record's embed, not the view.
   */
  async _downloadVideo(post, did, author, postText) {
    logger.info('Downloading Bluesky video via blob API');

    // Extract video CID from the record embed (original blob reference)
    const recordEmbed = post.record?.embed;
    const videoCID = recordEmbed?.video?.ref?.['$link'];
    const videoSize = recordEmbed?.video?.size || 0;

    // Also get the view-level data (has thumbnail, playlist URLs)
    const viewEmbed = post.embed;
    const thumbnailUrl = viewEmbed?.thumbnail;
    const aspectRatio = viewEmbed?.aspectRatio;

    if (!videoCID) {
      throw new Error('No video CID found in Bluesky post');
    }

    // Check size before downloading (Telegram limit)
    const maxSize = config.download.maxFileSizeMB * 1024 * 1024;
    if (videoSize > maxSize) {
      const sizeMB = (videoSize / (1024 * 1024)).toFixed(2);
      throw new Error(
        `This video is too large to send via Telegram.\n\n` +
        `Video size: ${sizeMB}MB\n` +
        `Telegram limit: ${config.download.maxFileSizeMB}MB`
      );
    }

    const videoFilename = generateFilename('bsky_video', 'mp4');
    const videoPath = path.join(config.download.tempDir, videoFilename);

    // Download the raw blob (original quality MP4)
    const blobUrl = `${BSKY_PDS_API}/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(videoCID)}`;

    try {
      logger.info(`Downloading blob: ${videoCID.substring(0, 20)}...`);

      const fsSync = require('fs');
      const response = await axios.get(blobUrl, {
        responseType: 'stream',
        timeout: 15000, // 15s to establish connection
        maxRedirects: 5,
        headers: {
          'Accept': '*/*'
        }
      });

      const contentLength = parseInt(response.headers['content-length'] || '0', 10);
      if (contentLength > maxSize) {
        response.data.destroy();
        throw new Error(`Video too large (${(contentLength / 1024 / 1024).toFixed(2)} MB)`);
      }

      const writer = fsSync.createWriteStream(videoPath);
      let downloadedBytes = 0;

      await new Promise((resolve, reject) => {
        response.data.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (downloadedBytes > maxSize) {
            response.data.destroy();
            writer.destroy();
            reject(new Error('Video exceeds maximum file size during download'));
          }
        });
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });

      logger.info(`Blob downloaded: ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB`);
    } catch (blobError) {
      // Clean up partial file
      await fs.unlink(videoPath).catch(() => {});
      logger.error(`Blob download failed: ${blobError.message}`);
      throw new Error(`Failed to download Bluesky video: ${blobError.message}`);
    }

    // Get video metadata via ffprobe
    let width = aspectRatio?.width || 720;
    let height = aspectRatio?.height || 1280;
    let durationSeconds = 0;
    let durationStr = 'Unknown';
    let fileSizeMB;

    try {
      const stats = await fs.stat(videoPath);
      fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    } catch {
      fileSizeMB = '0';
    }

    try {
      const { execSync } = require('child_process');
      const probeOutput = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration:format=duration -of json "${videoPath}"`,
        { encoding: 'utf8', timeout: 10000 }
      );
      const probeData = JSON.parse(probeOutput);

      if (probeData.streams && probeData.streams[0]) {
        width = probeData.streams[0].width || width;
        height = probeData.streams[0].height || height;
        const streamDuration = parseFloat(probeData.streams[0].duration);
        if (!isNaN(streamDuration)) {
          durationSeconds = Math.floor(streamDuration);
        }
      }
      if (!durationSeconds && probeData.format?.duration) {
        durationSeconds = Math.floor(parseFloat(probeData.format.duration));
      }

      if (durationSeconds > 0) {
        const minutes = Math.floor(durationSeconds / 60);
        const seconds = durationSeconds % 60;
        durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      }

      logger.debug(`Video metadata: ${width}x${height}, duration: ${durationStr}`);
    } catch (probeError) {
      logger.warn(`Failed to probe video metadata: ${probeError.message}`);
    }

    // Generate thumbnail from video
    let thumbnailPath = await generateThumbnailFromVideo(videoPath);

    // Determine quality label from actual resolution
    const actualQuality = height >= 1920 || width >= 1920 ? '1080p FullHD'
                        : height >= 1280 || width >= 1280 ? '720p HD'
                        : height >= 1024 || width >= 1024 ? `${Math.min(width, height)}p`
                        : `${Math.min(width, height)}p`;

    // Truncate post text for title
    const title = postText
      ? (postText.length > 200 ? postText.substring(0, 200) + '…' : postText)
      : 'Bluesky Video';

    return {
      type: 'video',
      filePath: videoPath,
      thumbnailPath: thumbnailPath,
      info: {
        title: title,
        author: author,
        platform: 'Bluesky',
        duration: durationStr,
        fileSize: `${fileSizeMB} MB`,
        quality: actualQuality
      },
      width: width,
      height: height,
      duration: durationSeconds
    };
  }

  /**
   * Download images from a Bluesky post.
   * Uses fullsize CDN URLs from the embed view.
   */
  async _downloadImages(post, author, postText) {
    const images = post.embed?.images;

    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('No images found in Bluesky post');
    }

    logger.info(`Found ${images.length} image(s) in Bluesky post`);

    const imagePaths = [];
    let totalBytes = 0;

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const imageUrl = img.fullsize || img.thumb;

      if (!imageUrl) {
        logger.warn(`No URL for image ${i + 1}, skipping`);
        continue;
      }

      const imageFilename = generateFilename(`bsky_img_${i}`, 'jpg');
      const imagePath = path.join(config.download.tempDir, imageFilename);

      try {
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'Accept': 'image/*,*/*'
          }
        });

        await fs.writeFile(imagePath, response.data);
        totalBytes += response.data.byteLength || response.data.length || 0;
        imagePaths.push(imagePath);
        logger.info(`Downloaded image ${i + 1}/${images.length}`);
      } catch (error) {
        logger.warn(`Failed to download image ${i + 1}: ${error.message}`);
      }
    }

    if (imagePaths.length === 0) {
      throw new Error('Failed to download any images from Bluesky post');
    }

    const title = postText
      ? (postText.length > 200 ? postText.substring(0, 200) + '…' : postText)
      : 'Bluesky Post';

    return {
      type: 'slideshow',
      imagePaths,
      info: {
        title: title,
        author: author,
        platform: 'Bluesky',
        fileSize: this._formatFileSize(totalBytes)
      }
    };
  }

  _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return 'Unknown';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i === 0) return `${bytes} ${sizes[i]}`;
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }
}

module.exports = new BlueskyService();
