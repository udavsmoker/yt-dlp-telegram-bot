const { igdl } = require('btch-downloader');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { generateFilename, ensureDir, generateThumbnailFromVideo, formatFileSize, formatDuration } = require('../utils/helpers');
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

      // Clean URL: strip tracking query parameters (exln, cplk, igsh, utm_*, etc.)
      let cleanUrlStr = url;
      try {
        const cleanUrl = new URL(url);
        cleanUrl.search = '';
        cleanUrl.hash = '';
        let pathname = cleanUrl.pathname;
        if (!pathname.endsWith('/')) pathname += '/';
        cleanUrl.pathname = pathname;
        cleanUrlStr = cleanUrl.toString();
      } catch {}

      // Get direct URLs from Instagram with retries
      let validItems = [];
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // On last attempt, try original url if cleanUrlStr is different
          const targetUrl = (attempt === maxRetries && cleanUrlStr !== url) ? url : cleanUrlStr;
          if (attempt > 1) {
            logger.info(`Retrying btch-downloader (attempt ${attempt}/${maxRetries}): ${targetUrl}`);
          }
          const btchResult = await igdl(targetUrl);
          
          if (btchResult && btchResult.status && Array.isArray(btchResult.result)) {
            validItems = btchResult.result.filter(item => item && item.url);
            if (validItems.length > 0) {
              break;
            }
          }
          logger.warn(`btch-downloader attempt ${attempt} returned no valid media URLs for ${targetUrl}`);
        } catch (err) {
          logger.warn(`btch-downloader attempt ${attempt} failed: ${err.message}`);
        }

        if (attempt < maxRetries) {
          await new Promise(res => setTimeout(res, 1200 * attempt));
        }
      }
      
      if (validItems.length === 0) {
        logger.warn(`btch-downloader returned no valid media URLs for ${cleanUrlStr} after ${maxRetries} attempts`);
        const isReel = url.includes('/reel/') || url.includes('/reels/');
        return { type: 'video', shouldFallback: true, isPhotoPostCandidate: !isReel };
      }

      logger.info(`btch-downloader found ${validItems.length} media item(s) (before dedup)`);

      // btch-downloader returns multiple CDN mirror/quality variants per carousel slide.
      // payload.filename is the SAME for all slides, and CDN filenames differ across
      // resolution variants, so neither works as a dedup key.
      // The correct key is `ig_cache_key` from the inner CDN URL — it's the base64-encoded
      // Instagram media ID, unique per carousel slide and consistent across quality variants.
      const seenKeys = new Set();
      const uniqueItems = validItems.filter(item => {
        try {
          const tokenMatch = item.url.match(/token=([^&]+)/);
          if (tokenMatch) {
            const payload = JSON.parse(Buffer.from(tokenMatch[1].split('.')[1], 'base64').toString());
            let key;
            if (payload.url) {
              try {
                const innerUrl = new URL(payload.url);
                // ig_cache_key is the Instagram media ID (unique per carousel slide)
                key = innerUrl.searchParams.get('ig_cache_key');
              } catch {}
              // Fallback: extract the CDN filename from path
              if (!key) {
                const pathPart = payload.url.split('?')[0];
                const segments = pathPart.split('/');
                key = segments[segments.length - 1];
              }
            }
            key = key || payload.url || item.url;
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
        let directUrl = null;

        // Check token payload if present
        try {
          const tokenMatch = item.url.match(/token=([^&]+)/);
          if (tokenMatch) {
            const payload = JSON.parse(Buffer.from(tokenMatch[1].split('.')[1], 'base64').toString());
            directUrl = payload.url || null;
            if (!isVideo) {
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
          }
        } catch (e) {
          // Ignore decoding errors
        }

        if (!isVideo && item.url) {
          // Check URL heuristics
          if (item.url.includes('.mp4') ||
              item.url.includes('/video/') ||
              item.url.includes('video_dashinit') ||
              item.url.includes('.mp4?')) {
            isVideo = true;
          }
        }

        if (isVideo) videoCount++;
        else imageCount++;

        return {
          url: item.url,
          directUrl: directUrl,
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
        let mediaUrl = detail.url;
        const mediaType = detail.type;
        
        // For images, rapidcdn (SnapSave proxy) has aggressive Cloudflare cache collisions that serve
        // identical cached responses for all slides. If we have the direct Instagram CDN URL in directUrl,
        // we use images.weserv.nl as an image proxy to fetch the exact slide and bypass the RKN block on Meta CDN.
        if (mediaType === 'image' && detail.directUrl) {
          mediaUrl = `https://images.weserv.nl/?url=${encodeURIComponent(detail.directUrl)}`;
        }

        const ext = mediaType === 'video' ? 'mp4' : 'jpg';
        const mediaPath = path.join(config.download.tempDir, `${filenamePrefix.replace(/\.$/, '')}_${i + 1}.${ext}`);
        
        try {
          let response;
          try {
            response = await axios({
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
          } catch (proxyErr) {
            // Fall back to original URL if proxy fails
            if (mediaUrl !== detail.url) {
              logger.warn(`Proxy download failed for item ${i + 1}, falling back to original URL: ${proxyErr.message}`);
              response = await axios({
                method: 'GET',
                url: detail.url,
                responseType: 'arraybuffer',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Referer': 'https://www.instagram.com/'
                },
                timeout: mediaType === 'video' ? 60000 : 30000,
                maxContentLength: 50 * 1024 * 1024
              });
            } else {
              throw proxyErr;
            }
          }

          await fs.writeFile(mediaPath, response.data);
          totalBytes += response.data.byteLength || response.data.length || 0;

          let thumbnailPath = null;
          if (mediaType === 'video') {
            thumbnailPath = await generateThumbnailFromVideo(mediaPath);
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
          const { execFileSync } = require('child_process');
          const ffprobeRes = execFileSync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,duration:format=duration',
            '-of', 'json',
            firstVideo.path
          ], { encoding: 'utf8', timeout: 5000 });
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
            durationStr = formatDuration(videoDurationSecs);
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
          fileSize: formatFileSize(totalBytes),
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


}

module.exports = new InstagramService();
