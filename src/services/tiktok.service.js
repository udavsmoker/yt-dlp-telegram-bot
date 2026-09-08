const TiktokDL = require('@tobyg74/tiktok-api-dl');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { generateFilename, ensureDir, generateThumbnailFromVideo } = require('../utils/helpers');
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

      // Call v3 and tikwm APIs in parallel for best coverage
      const [v3Result, tikwmResult] = await Promise.allSettled([
        TiktokDL.Downloader(url, { version: "v3" }).then(r => {
          if (r.status !== 'success') throw new Error('v3 failed');
          return r;
        }),
        axios.post('https://www.tikwm.com/api/', { url: url, hd: 1 }, { timeout: 15000 }).then(r => {
          if (!r.data || r.data.code !== 0) throw new Error(r.data?.msg || 'tikwm failed');
          return r.data.data;
        })
      ]);

      const v3Data = v3Result.status === 'fulfilled' ? v3Result.value.result : null;
      const twData = tikwmResult.status === 'fulfilled' ? tikwmResult.value : null;

      if (v3Result.status === 'rejected') logger.warn(`v3 API failed: ${v3Result.reason.message}`);
      if (tikwmResult.status === 'rejected') logger.warn(`tikwm API failed: ${tikwmResult.reason.message}`);

      if (!v3Data && !twData) {
        // Both failed, try v2/v1 as last resort
        logger.warn('Both v3 and tikwm failed, trying v2/v1');
        let result;
        try {
          result = await TiktokDL.Downloader(url, { version: "v2" });
          if (result.status !== 'success') throw new Error('v2 failed');
        } catch (v2Error) {
          logger.warn(`v2 failed: ${v2Error.message}, trying v1`);
          result = await TiktokDL.Downloader(url, { version: "v1" });
          if (result.status !== 'success') throw new Error('All TikTok APIs failed');
        }
        const data = result.result;
        logger.info(`TikTok data type: ${data.type}`);
        if (data.type === 'video') return await this._downloadVideo(data, url);
        if (data.type === 'image') return await this._downloadSlideshow(data, result);
        throw new Error(`Unknown TikTok content type: ${data.type}`);
      }

      // Determine content type
      const contentType = v3Data?.type || (twData?.images ? 'image' : 'video');
      logger.info(`TikTok data type: ${contentType}`);

      if (contentType === 'video') {
        // Merge video URLs from both APIs into priority-ordered list
        // v3 HD (1080p) > tikwm HD (720p) > v3 SD (576p)
        const mergedData = {
          _videoUrls: [],
          desc: v3Data?.desc || twData?.title,
          author: v3Data?.author || (twData?.author ? { nickname: twData.author.nickname || twData.author.unique_id } : undefined),
          cover: twData?.cover || undefined,
          music: twData?.music_info?.play ? { playUrl: [twData.music_info.play] } : (v3Data?.music || undefined)
        };

        // Add v3 HD URL (1080p, may be large)
        if (v3Data?.videoHD) {
          mergedData._videoUrls.push({ url: v3Data.videoHD, quality: 'v3 HD (1080p)' });
        }
        // Add tikwm HD URL (720p, reliable size)
        if (twData?.hdplay) {
          mergedData._videoUrls.push({ url: twData.hdplay, quality: 'tikwm HD (720p)' });
        } else if (twData?.play) {
          mergedData._videoUrls.push({ url: twData.play, quality: 'tikwm play' });
        }
        // Add v3 SD URL (576p, last resort)
        if (v3Data?.videoSD) {
          mergedData._videoUrls.push({ url: v3Data.videoSD, quality: 'v3 SD (576p)' });
        }

        logger.info(`Merged ${mergedData._videoUrls.length} video URLs from APIs`);
        logger.debug(`URL priorities: ${mergedData._videoUrls.map(u => u.quality).join(' > ')}`);

        return await this._downloadVideo(mergedData, url);
      }
      
      // Handle slideshow/image type
      if (contentType === 'image') {
        const data = twData ? {
          type: 'image',
          images: twData.images,
          desc: twData.title,
          author: { nickname: twData.author?.nickname || twData.author?.unique_id },
          music: twData.music_info?.play ? { playUrl: [twData.music_info.play] } : undefined
        } : v3Data;
        return await this._downloadSlideshow(data, { result: data });
      }

      throw new Error(`Unknown TikTok content type: ${contentType}`);
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
    
    // Use pre-merged URL list from parallel API calls, or build from single-API response
    const videoUrls = data._videoUrls || [
      { url: extractUrl(data.videoHD), quality: 'HD' },
      { url: extractUrl(data.videoSD), quality: 'SD' },
      { url: extractUrl(data.video?.noWatermark), quality: 'No Watermark' },
      { url: extractUrl(data.video?.playAddr), quality: 'playAddr' },
      { url: extractUrl(data.video?.downloadAddr), quality: 'downloadAddr' },
      { url: extractUrl(data.video?.play), quality: 'play' },
      { url: extractUrl(data.video), quality: 'video' }
    ].filter(item => item.url);
    
    // Try to get thumbnail/cover URL
    const thumbnailUrl = extractUrl(data.cover) ||
                         extractUrl(data.thumbnail) ||
                         extractUrl(data.originCover) ||
                         extractUrl(data.dynamicCover) ||
                         extractUrl(data.video?.cover) ||
                         extractUrl(data.video?.originCover);
    
    if (videoUrls.length === 0) {
      throw new Error('No video URL found in TikTok API response');
    }

    const videoFilename = generateFilename('tiktok_video', 'mp4');
    const videoPath = path.join(config.download.tempDir, videoFilename);
    
    // Will be extracted from video after download for perfect quality and aspect ratio
    let thumbnailPath = null;

    try {
      let videoResponse = null;
      let lastError = null;

      for (const item of videoUrls) {
        try {
          logger.info(`Trying to download ${item.quality} video URL...`);
          const streamResponse = await axios.get(item.url, {
            responseType: 'stream',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://www.tiktok.com/',
              'Accept': '*/*'
            },
            timeout: 15000 // 15 sec to establish connection and get headers
          });

          const contentLength = parseInt(streamResponse.headers['content-length'] || '0', 10);
          if (contentLength > 50 * 1024 * 1024) {
            streamResponse.data.destroy();
            throw new Error(`File too large (${(contentLength / 1024 / 1024).toFixed(2)} MB), max 50MB allowed`);
          }

          const fsSync = require('fs');
          const writer = fsSync.createWriteStream(videoPath);
          let downloadedBytes = 0;
          
          await new Promise((resolve, reject) => {
            streamResponse.data.on('data', (chunk) => {
              downloadedBytes += chunk.length;
              if (downloadedBytes > 50 * 1024 * 1024) {
                streamResponse.data.destroy();
                writer.destroy();
                reject(new Error('maxContentLength size of 52428800 exceeded during streaming'));
              }
            });
            streamResponse.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
            streamResponse.data.on('error', reject);
          });
          
          logger.info(`Successfully downloaded ${item.quality} video URL`);
          videoResponse = true;
          break; // Success
        } catch (err) {
          logger.warn(`Failed to download ${item.quality} video URL: ${err.message}`);
          lastError = err;
          await fs.unlink(videoPath).catch(() => {}); // Clean up partial file
        }
      }

      if (!videoResponse) {
        throw lastError || new Error('All video URLs failed to download');
      }
      
      let finalVideoPath = videoPath;
      let fileSizeMB;
      
      // Check audio bitrate and merge music track only if audio is low quality (<96kbps)
      const musicUrl = extractUrl(data.music?.playUrl) || extractUrl(data.music?.play_url);
      if (musicUrl) {
        try {
          const { execSync } = require('child_process');
          // Probe audio bitrate of downloaded video
          const audioBitrateStr = execSync(
            `ffprobe -v error -select_streams a:0 -show_entries stream=bit_rate -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
            { encoding: 'utf8', timeout: 10000 }
          ).trim();
          const audioBitrate = parseInt(audioBitrateStr) || 0;
          logger.info(`Video audio bitrate: ${Math.round(audioBitrate / 1000)}kbps`);
          
          if (audioBitrate > 0 && audioBitrate < 96000) {
            logger.info('Low audio bitrate detected, downloading separate music track...');
            const musicResponse = await axios.get(musicUrl, {
              responseType: 'arraybuffer',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.tiktok.com/',
                'Accept': '*/*'
              },
              timeout: 30000
            });
            
            const musicFilename = generateFilename('tiktok_music', 'mp3');
            const musicPath = path.join(config.download.tempDir, musicFilename);
            await fs.writeFile(musicPath, musicResponse.data);
            
            // Merge: take video from original, audio from music track
            const mergedPath = videoPath.replace('.mp4', '_merged.mp4');
            
            execSync(
              `ffmpeg -y -i "${videoPath}" -i "${musicPath}" -c:v copy -map 0:v:0 -map 1:a:0 -shortest -movflags +faststart "${mergedPath}"`,
              { stdio: 'ignore', timeout: 60000 }
            );
            
            // Replace original with merged version
            await fs.unlink(videoPath);
            await fs.unlink(musicPath).catch(() => {});
            finalVideoPath = mergedPath;
            
            logger.info('Merged video with high-quality music track');
          } else {
            logger.info('Audio quality is acceptable, skipping music merge');
          }
        } catch (musicError) {
          logger.warn(`Music merge check failed, using original audio: ${musicError.message}`);
        }
      }
      
      // Check frame rate and re-encode if too high (>60fps causes playback issues on Telegram/mobile)
      try {
        const { execSync } = require('child_process');
        const fpsOutput = execSync(
          `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${finalVideoPath}"`,
          { encoding: 'utf8', timeout: 10000 }
        ).trim();
        
        // Parse frame rate (format: "120/1" or "30000/1001")
        const [num, den] = fpsOutput.split('/').map(Number);
        const fps = den ? num / den : num;
        
        logger.info(`TikTok video frame rate: ${fps.toFixed(1)}fps`);
        
        if (fps > 60) {
          logger.warn(`High frame rate detected (${fps.toFixed(0)}fps), re-encoding to 30fps for Telegram compatibility`);
          
          const reencodedPath = finalVideoPath.replace('.mp4', '_30fps.mp4');
          
          execSync(
            `ffmpeg -i "${finalVideoPath}" -r 30 -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${reencodedPath}"`,
            { stdio: 'ignore', timeout: 180000 } // 3 minutes timeout
          );
          
          // Replace original with re-encoded version
          await fs.unlink(finalVideoPath);
          finalVideoPath = reencodedPath;
          
          const stats = await fs.stat(finalVideoPath);
          fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          
          logger.info(`Re-encoded to 30fps: ${fileSizeMB}MB`);
        } else {
          const stats = await fs.stat(finalVideoPath);
          fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          logger.info(`TikTok video downloaded: ${fileSizeMB}MB`);
        }
      } catch (fpsError) {
        logger.warn(`Frame rate check failed: ${fpsError.message} - using original video`);
        const stats = await fs.stat(finalVideoPath);
        fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
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

      // Extract thumbnail from video (scaled to Telegram's 320px/200KB limits)
      if (!thumbnailPath) {
        thumbnailPath = await generateThumbnailFromVideo(finalVideoPath);
      }

      // Determine quality label from actual resolution
      const actualQuality = height >= 1920 || width >= 1920 ? '1080p FullHD'
                          : height >= 1280 || width >= 1280 ? '720p HD'
                          : height >= 1024 || width >= 1024 ? `${Math.min(width, height)}p`
                          : `${Math.min(width, height)}p`;

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
          quality: actualQuality
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
