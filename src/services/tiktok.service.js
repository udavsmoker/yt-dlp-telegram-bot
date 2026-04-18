const TiktokDL = require('@tobyg74/tiktok-api-dl');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { generateFilename, ensureDir } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');

class TikTokService {
  /**
   * Download TikTok content (video or slideshow) using the TikTok API
   * This is used as a fallback when yt-dlp fails
   */
  async downloadTikTokContent(url) {
    try {
      logger.info(`Downloading TikTok content using @tobyg74/tiktok-api-dl: ${url}`);
      
      await ensureDir(config.download.tempDir);

      let result;
      let version = 'v2'; // v2 has higher success rate for restricted videos
      
      // Try v2 first, then v3, then v1, then tikwm
      try {
        result = await TiktokDL.Downloader(url, { version: "v2" });
        if (result.status !== 'success') {
          throw new Error('v2 failed');
        }
      } catch (v2Error) {
        logger.warn(`v2 API failed, trying v3: ${v2Error.message}`);
        version = 'v3';
        try {
          result = await TiktokDL.Downloader(url, { version: "v3" });
          if (result.status !== 'success') {
            throw new Error('v3 failed');
          }
        } catch (v3Error) {
          logger.warn(`v3 API failed, trying v1: ${v3Error.message}`);
          version = 'v1';
          try {
            result = await TiktokDL.Downloader(url, { version: "v1" });
          } catch (v1Error) {
            logger.warn(`v1 API failed, trying tikwm API: ${v1Error.message}`);
            version = 'tikwm';
          }
        }
      }

      if (version === 'tikwm' || !result || result.status !== 'success') {
        try {
          const tikwmResponse = await axios.post('https://www.tikwm.com/api/', { url: url, hd: 1 });
          if (tikwmResponse.data && tikwmResponse.data.code === 0) {
            const twData = tikwmResponse.data.data;
            result = {
              status: 'success',
              result: {
                type: twData.images ? 'image' : 'video',
                videoHD: twData.hdplay || twData.play,
                cover: twData.cover,
                images: twData.images
              }
            };
            version = 'tikwm';
          } else {
             throw new Error(tikwmResponse.data?.msg || 'tikwm failed');
          }
        } catch (twError) {
           throw new Error(`TikTok API error: ${twError.message || 'Unknown error'}`);
        }
      }

      logger.info(`TikTok API response status: ${result.status} (using ${version})`);

      const data = result.result;
      
      logger.info(`TikTok data type: ${data.type}`);
      logger.debug(`Available keys: ${Object.keys(data).join(', ')}`);
      
      if (data.author) {
        logger.debug(`author keys: ${Object.keys(data.author).join(', ')}`);
      }

      // Handle video type
      if (data.type === 'video') {
        return await this._downloadVideo(data, url);
      }
      
      // Handle slideshow/image type
      if (data.type === 'image') {
        return await this._downloadSlideshow(data, result);
      }

      throw new Error(`Unknown TikTok content type: ${data.type}`);
    } catch (error) {
      logger.error(`TikTok download error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download TikTok video using API data
   */
  async _downloadVideo(data, originalUrl) {
    logger.info('Downloading TikTok video via API');
    
    // Helper to extract URL from value (could be string, array of strings, or array of objects)
    const extractUrl = (value) => {
      if (!value) return null;
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (typeof first === 'string') return first;
        if (first?.url) return first.url;
      }
      if (value?.url) return value.url;
      return null;
    };
    
    // Try to get video URL - prioritize HD quality (v3 API format)
    // v3 API structure: data.videoHD, data.videoSD
    // v1 API structure: data.video.noWatermark, data.video.playAddr
    const videoUrl = extractUrl(data.videoHD) ||  // v3 HD
                     extractUrl(data.videoSD) ||   // v3 SD
                     extractUrl(data.video?.noWatermark) ||  // v1
                     extractUrl(data.video?.playAddr) ||
                     extractUrl(data.video?.downloadAddr) ||
                     extractUrl(data.video?.play) ||
                     extractUrl(data.video);
    
    // Try to get thumbnail/cover URL (v3 API doesn't have cover, v1 might)
    const thumbnailUrl = extractUrl(data.cover) ||
                         extractUrl(data.thumbnail) ||
                         extractUrl(data.originCover) ||
                         extractUrl(data.dynamicCover) ||
                         extractUrl(data.video?.cover) ||
                         extractUrl(data.video?.originCover);
    
    // Log available keys for debugging
    logger.debug(`Video data keys: ${Object.keys(data).join(', ')}`);
    
    // Determine quality for logging
    let quality = 'Unknown';
    if (data.videoHD) quality = 'HD';
    else if (data.videoSD) quality = 'SD';
    else if (data.video?.noWatermark) quality = 'No Watermark';
    else if (data.video?.ratio) quality = data.video.ratio;
    
    if (!videoUrl) {
      logger.error(`Video data structure keys: ${Object.keys(data).join(', ')}`);
      throw new Error('No video URL found in TikTok API response');
    }

    logger.info(`Found ${quality} video URL, downloading...`);
    if (thumbnailUrl) {
      logger.info('Found thumbnail URL in API response');
    } else {
      logger.info('No thumbnail URL in API response, will extract from video');
    }
    
    const videoFilename = generateFilename('tiktok_video', 'mp4');
    const videoPath = path.join(config.download.tempDir, videoFilename);
    
    // Will be set after video download if we need to extract thumbnail
    let thumbnailPath = null;
    
    // Download thumbnail from URL if available
    if (thumbnailUrl) {
      try {
        const thumbFilename = generateFilename('tiktok_thumb', 'jpg');
        thumbnailPath = path.join(config.download.tempDir, thumbFilename);
        
        const thumbResponse = await axios.get(thumbnailUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.tiktok.com/'
          },
          timeout: 15000
        });
        
        await fs.writeFile(thumbnailPath, thumbResponse.data);
        logger.info('Downloaded thumbnail from URL');
      } catch (thumbError) {
        logger.warn(`Failed to download thumbnail: ${thumbError.message}`);
        thumbnailPath = null;
      }
    }

    try {
      const videoResponse = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.tiktok.com/',
          'Accept': '*/*'
        },
        timeout: 120000, // 2 minutes for large videos
        maxContentLength: 100 * 1024 * 1024 // 100MB max
      });

      await fs.writeFile(videoPath, videoResponse.data);
      
      let finalVideoPath = videoPath;
      let fileSizeMB;
      
      // Check frame rate and re-encode if too high (>60fps causes playback issues on Telegram/mobile)
      try {
        const { execSync } = require('child_process');
        const fpsOutput = execSync(
          `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
          { encoding: 'utf8', timeout: 10000 }
        ).trim();
        
        // Parse frame rate (format: "120/1" or "30000/1001")
        const [num, den] = fpsOutput.split('/').map(Number);
        const fps = den ? num / den : num;
        
        logger.info(`TikTok video frame rate: ${fps.toFixed(1)}fps`);
        
        if (fps > 60) {
          logger.warn(`High frame rate detected (${fps.toFixed(0)}fps), re-encoding to 30fps for Telegram compatibility`);
          
          const reencodedPath = videoPath.replace('.mp4', '_30fps.mp4');
          
          execSync(
            `ffmpeg -i "${videoPath}" -r 30 -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${reencodedPath}"`,
            { stdio: 'ignore', timeout: 180000 } // 3 minutes timeout
          );
          
          // Replace original with re-encoded version
          await fs.unlink(videoPath);
          finalVideoPath = reencodedPath;
          
          const stats = await fs.stat(finalVideoPath);
          fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          
          logger.info(`Re-encoded to 30fps: ${fileSizeMB}MB`);
        } else {
          const fileSizeBytes = videoResponse.data.length;
          fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
          logger.info(`TikTok video downloaded: ${fileSizeMB}MB`);
        }
      } catch (fpsError) {
        logger.warn(`Frame rate check failed: ${fpsError.message} - using original video`);
        const fileSizeBytes = videoResponse.data.length;
        fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
        logger.info(`TikTok video downloaded: ${fileSizeMB}MB`);
      }

      // Get duration and dimensions from the actual file using ffprobe
      let durationStr = 'Unknown';
      let durationSeconds = 0;
      let width = 720, height = 1280;
      
      try {
        const { execSync } = require('child_process');
        const probeOutput = execSync(
          `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration:format=duration -of json "${finalVideoPath}"`,
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
        logger.warn(`Failed to get video metadata: ${probeError.message}`);
      }

      // Extract thumbnail from video if not downloaded from API
      if (!thumbnailPath) {
        try {
          const { execSync } = require('child_process');
          const thumbFilename = generateFilename('tiktok_thumb', 'jpg');
          thumbnailPath = path.join(config.download.tempDir, thumbFilename);
          
          // Extract frame at 1 second (or 0.5 seconds for short videos)
          const seekTime = durationSeconds > 2 ? '1' : '0.5';
          
          execSync(
            `ffmpeg -y -ss ${seekTime} -i "${finalVideoPath}" -vframes 1 -q:v 2 "${thumbnailPath}"`,
            { stdio: 'ignore', timeout: 10000 }
          );
          
          // Verify thumbnail was created
          await fs.access(thumbnailPath);
          logger.info('Extracted thumbnail from video');
        } catch (thumbError) {
          logger.warn(`Failed to extract thumbnail: ${thumbError.message}`);
          thumbnailPath = null;
        }
      }

      return {
        type: 'video',
        filePath: finalVideoPath,
        thumbnailPath: thumbnailPath,
        info: {
          title: data.desc || data.title || 'TikTok Video',
          author: data.author?.nickname || data.author?.uniqueId || data.author?.unique_id || 'Unknown',
          platform: 'TikTok',
          duration: durationStr,
          fileSize: `${fileSizeMB} MB`,
          quality: quality
        },
        width: width,
        height: height,
        duration: durationSeconds
      };
    } catch (downloadError) {
      logger.error(`Failed to download video: ${downloadError.message}`);
      throw new Error(`Failed to download TikTok video: ${downloadError.message}`);
    }
  }

  /**
   * Download TikTok slideshow images
   */
  async _downloadSlideshow(data, result) {
    const images = data.images || data.image || [];
      
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('No images found in slideshow');
    }

    logger.info(`Found ${images.length} images in slideshow`);

    const imagePaths = [];
    for (let i = 0; i < images.length; i++) {
      const imageUrl = typeof images[i] === 'string' ? images[i] : images[i]?.url;
      
      if (!imageUrl) {
        logger.warn(`No URL for image ${i + 1}, skipping`);
        continue;
      }
      
      const imageFilename = generateFilename(`tiktok_slide_${i}`, 'jpg');
      const imagePath = path.join(config.download.tempDir, imageFilename);

      try {
        const imageResponse = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.tiktok.com/'
          },
          timeout: 30000
        });

        await fs.writeFile(imagePath, imageResponse.data);
        imagePaths.push(imagePath);
        logger.info(`Downloaded image ${i + 1}/${images.length}`);
      } catch (error) {
        logger.warn(`Failed to download image ${i + 1}: ${error.message}`);
      }
    }

    if (imagePaths.length === 0) {
      throw new Error('Failed to download any images from slideshow');
    }

    return {
      type: 'slideshow',
      imagePaths,
      audioPath: null,
      info: {
        title: data.title || data.desc || data.description || result.title || result.desc || 'TikTok Slideshow',
        author: data.author?.nickname || data.author?.uniqueId || data.author?.unique_id || data.author?.name || 'Unknown',
        platform: 'TikTok'
      }
    };
  }

  // Keep old method name for backwards compatibility
  async downloadTikTokSlideshow(url) {
    return this.downloadTikTokContent(url);
  }
}

module.exports = new TikTokService();
