const { igdl } = require('btch-downloader');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { generateFilename, ensureDir } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');

class InstagramService {
  /**
   * Fetch title and author from Instagram's public oEmbed API.
   * No authentication required for public posts.
   */
  async getInstagramMetadata(url) {
    try {
      const oembedUrl = `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(url)}&maxwidth=320&hidecaption=false&omitscript=true`;
      const res = await axios.get(oembedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 8000
      });
      return {
        title: res.data.title || 'Instagram Post',
        author: res.data.author_name || 'Unknown'
      };
    } catch (e) {
      logger.warn(`Could not fetch Instagram oEmbed metadata: ${e.message}`);
      return { title: 'Instagram Post', author: 'Unknown' };
    }
  }

  /**
   * Download Instagram content (photos or video) from a post URL
   * Handles single images, carousels, and videos/Reels
   */
  async downloadInstagramPost(url, imgIndex = null) {
    try {
      logger.info(`Downloading Instagram post using btch-downloader (igdl): ${url}`);

      await ensureDir(config.download.tempDir);

      // Clean img_index from URL before querying API
      let cleanUrlStr = url;
      try {
        const cleanUrl = new URL(url);
        cleanUrl.searchParams.delete('img_index');
        cleanUrlStr = cleanUrl.toString();
      } catch {}

      // Get direct URLs from Instagram
      const btchResult = await igdl(cleanUrlStr);
      
      if (!btchResult || !btchResult.status || !Array.isArray(btchResult.result)) {
        logger.warn(`btch-downloader failed for ${cleanUrlStr}: ${btchResult?.message || 'Invalid API response'}`);
        // Return shouldFallback to try yt-dlp
        return { type: 'video', shouldFallback: true };
      }

      // Filter out invalid items (like empty objects from 401 error)
      const validItems = btchResult.result.filter(item => item && item.url);
      
      if (validItems.length === 0) {
        logger.warn(`btch-downloader returned no valid media URLs for ${cleanUrlStr}`);
        return { type: 'video', shouldFallback: true };
      }

      logger.info(`btch-downloader found ${validItems.length} media item(s) (before dedup)`);

      // btch-downloader returns multiple quality variants per media item.
      // Deduplicate by the original filename embedded in the JWT token payload.
      // Items without a decodable token keep their proxied URL as key.
      const seenKeys = new Set();
      const uniqueItems = validItems.filter(item => {
        try {
          const tokenMatch = item.url.match(/token=([^&]+)/);
          if (tokenMatch) {
            const payload = JSON.parse(Buffer.from(tokenMatch[1].split('.')[1], 'base64').toString());
            const key = payload.filename || payload.url || item.url;
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
          }
        } catch { /* fall through */ }
        // No decodable token — use the URL itself as key
        if (seenKeys.has(item.url)) return false;
        seenKeys.add(item.url);
        return true;
      });

      logger.info(`After dedup: ${uniqueItems.length} unique media item(s)`);

      const filenamePrefix = generateFilename('insta', '');
      const downloadedMedia = [];
      let totalBytes = 0;

      let imageCount = 0;
      let videoCount = 0;

      // Check if it's a reel
      const isReel = url.includes('/reel/');

      // Map details and check types
      const mediaDetails = uniqueItems.map((item) => {
        const typeFromApi = typeof item.type === 'string' ? item.type.toLowerCase() : '';
        let isVideo = isReel || typeFromApi === 'video';

        if (!isVideo && item.url) {
          // Check URL heuristics
          if (item.url.includes('.mp4') ||
              item.url.includes('/video/') ||
              item.url.includes('video_dashinit') ||
              item.url.includes('.mp4?')) {
            isVideo = true;
          } else {
            // Check token payload if present
            try {
              const tokenMatch = item.url.match(/token=([^&]+)/);
              if (tokenMatch) {
                const payload = JSON.parse(Buffer.from(tokenMatch[1].split('.')[1], 'base64').toString());
                const filename = (payload.filename || '').toLowerCase();
                const innerUrl = (payload.url || '').toLowerCase();
                if (filename.endsWith('.mp4') || 
                    filename.includes('.mp4') ||
                    innerUrl.includes('.mp4') || 
                    innerUrl.includes('/video/') || 
                    innerUrl.includes('video_dashinit')) {
                  isVideo = true;
                }
              }
            } catch (e) {
              // Ignore decoding errors
            }
          }
        }

        if (isVideo) videoCount++;
        else imageCount++;

        return {
          url: item.url,
          type: isVideo ? 'video' : 'image'
        };
      });

      // Filter to single item if imgIndex is specified
      if (imgIndex !== null && imgIndex >= 1 && imgIndex <= mediaDetails.length) {
        const selected = mediaDetails[imgIndex - 1];
        mediaDetails.splice(0, mediaDetails.length, selected);
        imageCount = selected.type === 'image' ? 1 : 0;
        videoCount = selected.type === 'video' ? 1 : 0;
        logger.info(`Filtered to single item at index ${imgIndex}`);
      } else if (imgIndex !== null && (imgIndex < 1 || imgIndex > mediaDetails.length)) {
        logger.warn(`imgIndex ${imgIndex} is out of bounds (1..${mediaDetails.length}), downloading all items`);
      }

      logger.info(`Media details: ${imageCount} image(s), ${videoCount} video(s)`);
      
      // Download each media item in order
      for (let i = 0; i < mediaDetails.length; i++) {
        const detail = mediaDetails[i];
        const mediaUrl = detail.url;
        const mediaType = detail.type;
        
        const ext = mediaType === 'video' ? 'mp4' : 'jpg';
        const mediaPath = path.join(config.download.tempDir, `${filenamePrefix.replace(/\.$/, '')}_${i + 1}.${ext}`);
        
        try {
          const response = await axios({
            method: 'GET',
            url: mediaUrl,
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://www.instagram.com/'
            },
            timeout: mediaType === 'video' ? 60000 : 30000,
            maxContentLength: 50 * 1024 * 1024 // 50MB max
          });

          await fs.writeFile(mediaPath, response.data);
          totalBytes += response.data.byteLength || response.data.length || 0;

          let thumbnailPath = null;
          if (mediaType === 'video') {
            const thumbPath = mediaPath.replace(/\.mp4$/, '_thumb.jpg');
            try {
              const { execSync } = require('child_process');
              execSync(
                `ffmpeg -y -i "${mediaPath}" -ss 00:00:01 -vframes 1 -f image2 "${thumbPath}"`,
                { stdio: 'ignore', timeout: 5000 }
              );
              thumbnailPath = thumbPath;
            } catch (e) {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `ffmpeg -y -i "${mediaPath}" -ss 00:00:00 -vframes 1 -f image2 "${thumbPath}"`,
                  { stdio: 'ignore', timeout: 5000 }
                );
                thumbnailPath = thumbPath;
              } catch (err) {
                logger.warn(`Could not generate thumbnail for video: ${err.message}`);
              }
            }
          }

          downloadedMedia.push({ 
            type: mediaType === 'video' ? 'video' : 'photo', 
            path: mediaPath,
            thumbnailPath: thumbnailPath
          });
          logger.info(`Downloaded ${mediaType} ${i + 1}/${mediaDetails.length}`);
        } catch (downloadError) {
          logger.error(`Failed to download ${mediaType} ${i + 1}: ${downloadError.message}`);
        }
      }

      if (downloadedMedia.length === 0) {
        throw new Error('Failed to download any media from the post');
      }

      const meta = await this.getInstagramMetadata(url);

      // Extract metadata (width, height, duration) from the first video file (e.g. Reels)
      let videoWidth = undefined;
      let videoHeight = undefined;
      let videoDurationSecs = undefined;
      let durationStr = null;

      const firstVideo = downloadedMedia.find(m => m.type === 'video');
      if (firstVideo) {
        try {
          const { execSync } = require('child_process');
          const ffprobeRes = execSync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration:format=duration -of json "${firstVideo.path}"`,
            { encoding: 'utf8', timeout: 5000 }
          );
          const parsed = JSON.parse(ffprobeRes);
          if (parsed.streams && parsed.streams[0]) {
            videoWidth = parsed.streams[0].width || undefined;
            videoHeight = parsed.streams[0].height || undefined;
            videoDurationSecs = parseFloat(parsed.streams[0].duration) || undefined;
          }
          if (!videoDurationSecs && parsed.format && parsed.format.duration) {
            videoDurationSecs = parseFloat(parsed.format.duration) || undefined;
          }
          if (videoDurationSecs) {
            durationStr = this.formatDuration(videoDurationSecs);
          }
        } catch (e) {
          logger.warn(`Could not extract video metadata with ffprobe: ${e.message}`);
        }
      }

      const finalImageCount = downloadedMedia.filter(m => m.type === 'photo').length;
      const finalVideoCount = downloadedMedia.filter(m => m.type === 'video').length;

      return {
        type: 'mixed', // Can contain photos and videos
        media: downloadedMedia,
        imagePaths: downloadedMedia.filter(m => m.type === 'photo').map(m => m.path),
        videoPaths: downloadedMedia.filter(m => m.type === 'video').map(m => m.path),
        width: videoWidth,
        height: videoHeight,
        duration: videoDurationSecs,
        info: {
          title: meta.title,
          author: meta.author,
          platform: 'Instagram',
          duration: durationStr,
          fileSize: this.formatFileSize(totalBytes),
          imageCount: finalImageCount,
          videoCount: finalVideoCount
        }
      };

    } catch (error) {
      logger.error('Instagram download error:', error);
      
      if (error.message.includes('Failed to download any media')) {
        throw error;
      }
      
      throw new Error(`Instagram download failed: ${error.message}`);
    }
  }

  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return 'Unknown';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i === 0) return `${bytes} ${sizes[i]}`;
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  formatDuration(seconds) {
    if (!seconds) return null;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}

module.exports = new InstagramService();
