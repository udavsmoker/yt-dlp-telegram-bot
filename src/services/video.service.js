const youtubedlExec = require('youtube-dl-exec');
const path = require('path');
const fs = require('fs').promises;
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const axios = require('axios');
const { generateFilename, ensureDir, prepareThumbnail, generateThumbnailFromVideo, formatFileSize, formatDuration, getYtdlpPath } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');
const tiktokService = require('./tiktok.service');
const instagramService = require('./instagram.service');
const blueskyService = require('./bluesky.service');

// Load extra patterns from local config (gitignored)
let localConfig = { extraDomains: [], hlsPatterns: [], problematicPatterns: [] };
try {
  const configPath = path.join(__dirname, '../../local-domains.json');
  localConfig = require(configPath);
} catch (e) {
  // Local config doesn't exist, that's fine
}

// Use system yt-dlp (with PO Token plugin) instead of bundled one
const youtubedl = youtubedlExec.create(getYtdlpPath());

class VideoService {
  constructor() {
    this.ytdlpPath = 'yt-dlp';
  }

  async download(url, options = {}, onProgress = null) {
    if (typeof options === 'function') {
      onProgress = options;
      options = {};
    }

    if (options.signal?.aborted) {
      throw new Error('DOWNLOAD_CANCELLED');
    }

    try {
      logger.info(`Starting download with yt-dlp: ${url}`);
      
      await ensureDir(config.download.tempDir);
      
      const filename = generateFilename('video', 'mp4');
      const outputTemplate = path.join(config.download.tempDir, filename.replace('.mp4', '.%(ext)s'));
      const thumbnailFilename = generateFilename('thumb', 'jpg');
      const thumbnailPath = path.join(config.download.tempDir, thumbnailFilename);

      const maxSizeBytes = config.download.maxFileSizeMB * 1024 * 1024;

      // Determine a safe Referer based on the input URL (prevents 403 on non-YouTube sites)
      let refererHeader = undefined;
      try {
        const u = new URL(url);
        refererHeader = url;
      } catch {}

      let isYouTube = false;
      let isTikTok = false;
      let usesHLS = false;
      let isProblematicSite = false; // Sites with filename issues
      try {
        const host = new URL(url).hostname.toLowerCase().replace('www.', '');
        isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
        isTikTok = host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'vm.tiktok.com' || host === 'vt.tiktok.com';

        // Twitter API workaround
        const isTwitter = host === 'twitter.com' || host === 'x.com' || host === 'vxtwitter.com' || host === 'fxtwitter.com' || host === 'fixupx.com';
        if (isTwitter) {
          const match = url.match(/(?:\/status\/|\/post\/)([0-9]+)/);
          if (match) {
             try {
               const res = await axios.get(`https://api.fxtwitter.com/status/${match[1]}`);
               if (res.data && res.data.tweet && res.data.tweet.media && res.data.tweet.media.videos && res.data.tweet.media.videos.length > 0) {
                 url = res.data.tweet.media.videos[0].url;
                 logger.info(`Resolved Twitter video URL via fxtwitter: ${url}`);
               } else if (res.data && res.data.tweet && res.data.tweet.media && res.data.tweet.media.all && res.data.tweet.media.all.length > 0) {
                 const vid = res.data.tweet.media.all.find(m => m.type === 'video' || m.type === 'gif');
                 if (vid) {
                   url = vid.url;
                   logger.info(`Resolved Twitter video URL via fxtwitter 'all': ${url}`);
                 } else {
                   const photos = res.data.tweet.media.all.filter(m => m.type === 'photo');
                   if (photos.length > 0) {
                     logger.info(`Found ${photos.length} photos in Twitter post, downloading...`);
                     const imagePaths = [];
                     for (let i = 0; i < photos.length; i++) {
                       const photoUrl = photos[i].url;
                       const imageFilename = generateFilename(`twitter_photo_${i}`, 'jpg');
                       const imagePath = path.join(config.download.tempDir, imageFilename);
                       const photoRes = await axios.get(photoUrl, { responseType: 'arraybuffer', timeout: 30000 });
                       await fs.writeFile(imagePath, photoRes.data);
                       imagePaths.push(imagePath);
                     }
                     return {
                       type: 'slideshow',
                       imagePaths,
                       info: {
                         author: res.data.tweet.author?.name || res.data.tweet.author?.screen_name || 'Twitter User',
                         platform: 'Twitter/X',
                         title: (res.data.tweet.text || 'Twitter Post').substring(0, 100)
                       }
                     };
                   } else {
                     throw new Error('NO_MEDIA_IN_TWEET');
                   }
                 }
               } else {
                 throw new Error('NO_MEDIA_IN_TWEET');
               }
             } catch (txError) {
               logger.warn(`Failed to resolve via fxtwitter API: ${txError.message}`);
               if (txError.message === 'NO_MEDIA_IN_TWEET') {
                 throw new Error('No media could be found in this tweet');
               }
             }
          }
        }

        // HLS patterns from local config (for sites that need special handling)
        const hlsPatterns = localConfig.hlsPatterns || [];
        usesHLS = hlsPatterns.some(pattern => host.includes(pattern));
        // Problematic sites from local config (filename issues)
        const problematicPatterns = localConfig.problematicPatterns || [];
        isProblematicSite = problematicPatterns.some(pattern => host.includes(pattern));
      } catch {}

      // iOS/Telegram compatibility: H.264/AVC + AAC audio, excludes VP9/HEVC
      // YouTube strategies: Provide max quality if cookies present, or fallback to progressive
      const youtubeStrategies = [
        { name: '1080p mp4', format: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best' },
        { name: '720p mp4', format: '22/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/18' },
        { name: '360p mp4', format: '18/best[height<=360][ext=mp4]/worst[ext=mp4]' }
      ];

      const hlsStrategies = [
        { name: 'best available', format: 'bv*+ba/b' },
        { name: '1080p or lower', format: 'bv*[height<=1080]+ba/b[height<=1080]' },
        { name: '720p or lower', format: 'bv*[height<=720]+ba/b[height<=720]' },
        { name: '480p or lower', format: 'bv*[height<=480]+ba/b[height<=480]' },
        { name: 'worst', format: 'wv*+wa/w' },
      ];

      const genericStrategies = [
        { name: 'best mp4 direct', format: 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best' },
        { name: '1080p max', format: 'bestvideo[height<=1080][ext=mp4]+bestaudio/best[height<=1080]' },
        { name: '720p max', format: 'bestvideo[height<=720][ext=mp4]+bestaudio/best[height<=720]' },
        { name: '480p max', format: 'bestvideo[height<=480][ext=mp4]+bestaudio/best[height<=480]' },
        { name: 'worst quality', format: 'worst' },
      ];

      let formatStrategies = isYouTube ? youtubeStrategies : usesHLS ? hlsStrategies : genericStrategies;
      if (options.format) {
        formatStrategies = [{ name: options.qualityName || 'custom requested', format: options.format }, ...formatStrategies];
      }

      let downloadedFilePath = null;
      let usedQuality = null;
      let lastYtdlpError = null;

      for (const strategy of formatStrategies) {
        try {
          logger.info(`Attempting download with ${strategy.name} format`);
          
          if (downloadedFilePath) {
            try {
              await fs.unlink(downloadedFilePath);
            } catch {}
          }

          const ytdlpOptions = {
            output: outputTemplate,
            format: strategy.format,
            mergeOutputFormat: 'mp4',
            noPlaylist: true,
            noWarnings: true,
            noCheckCertificates: true,
            preferFreeFormats: true,
            // Disable metadata to prevent postprocessing errors with special chars
            noPostOverwrites: true,
            writeInfoJson: true,
            writeThumbnail: true,
            convertThumbnails: 'jpg',
            restrictFilenames: true,
            windowsFilenames: true, // Extra-strict filename sanitization (works on all OSes)
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...(refererHeader ? { referer: refererHeader } : {}),
            // Use cookies if configured
            ...(config.download.cookiesFile ? { cookies: config.download.cookiesFile } : {}),
            hlsPreferNative: true,
            externalDownloader: 'native',
            formatSort: 'vcodec:h264,res,acodec:m4a',
            // Use reduced retries for HLS-heavy sites (slower metadata extraction)
            retries: usesHLS ? 3 : 10,
            fragmentRetries: usesHLS ? 3 : 10,
            // Skip unavailable fragments (livestreams)
            skipUnavailableFragments: true
          };

          // Let yt-dlp use default web client + PO Token plugin instead of restricting it!
          // (bgutil-pot.service will handle the bot protection automatically)
          if (isTikTok) {
            ytdlpOptions.extractorArgs = 'tiktok:api_hostname=api19-va.tiktokv.com';
            logger.info('Using TikTok API hostname workaround');
          }

          if (options.signal?.aborted) {
            throw new Error('DOWNLOAD_CANCELLED');
          }

          let downloadOutput;
          try {
            const execOptions = {
              ...ytdlpOptions,
              newline: true,
              progress: true,
              progressTemplate: 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s'
            };

            const proc = youtubedl.exec(url, execOptions, options.signal ? { signal: options.signal } : {});

            if (onProgress && proc.stdout) {
              const handleChunk = (chunk) => {
                const text = chunk.toString();
                const lines = text.split('\n');
                for (const line of lines) {
                  // Custom template format: [download:] <percent>%|<speed>|<eta>
                  let m = line.match(/(?:download:)?\s*(\d+\.?\d*)%\|\s*([^|]+)\|\s*([^\r\n]+)/);
                  if (m) {
                    onProgress({
                      percent: parseFloat(m[1]),
                      speed: m[2].trim(),
                      eta: m[3].trim()
                    });
                    continue;
                  }
                  // Fallback for standard yt-dlp progress lines
                  m = line.match(/\[download\]\s+(\d+\.?\d*)%.*?\bat\s+(\S+).*?\bETA\s+(\S+)/);
                  if (m) {
                    onProgress({
                      percent: parseFloat(m[1]),
                      speed: m[2].trim(),
                      eta: m[3].trim()
                    });
                  }
                }
              };

              proc.stdout.on('data', handleChunk);
              if (proc.stderr) proc.stderr.on('data', handleChunk);
            }

            downloadOutput = await proc;
            if (downloadOutput) {
              logger.debug(`yt-dlp output for ${strategy.name}: ${JSON.stringify(downloadOutput).substring(0, 200)}`);
            }
          } catch (ytdlpError) {
            if (options.signal?.aborted || ytdlpError.name === 'AbortError' || ytdlpError.code === 'ERR_ABORTED') {
              throw new Error('DOWNLOAD_CANCELLED');
            }

            // Log yt-dlp errors but continue to next strategy
            const errorMsg = ytdlpError.message || '';
            const stderr = ytdlpError.stderr || '';
            
            lastYtdlpError = stderr || errorMsg;
            
            logger.warn(`yt-dlp failed with ${strategy.name}: ${errorMsg}`);
            
            // Check for specific error types
            if (stderr.includes('Failed to resolve') || stderr.includes('Temporary failure in name resolution')) {
              logger.error('DNS resolution failed - network or firewall may be blocking access');
            } else if (stderr.includes('Unable to download webpage')) {
              logger.error('Cannot connect to site - may be blocked by firewall or ISP');
            }
            
            if (stderr) {
              logger.debug(`yt-dlp stderr: ${stderr.substring(0, 500)}`);
            }

            // Don't retry different video quality formats if the post simply contains no video or is private
            if (stderr.includes('There is no video in this post') ||
                stderr.includes('This post is private') ||
                stderr.includes('Video unavailable') ||
                stderr.includes('Sign in to confirm your age')) {
              logger.info(`Non-retryable yt-dlp error encountered, aborting quality fallbacks`);
              break;
            }

            continue;
          }

          const files = await fs.readdir(config.download.tempDir);
          logger.debug(`Looking for file matching: ${filename.replace('.mp4', '')}`);
          logger.debug(`Files in temp dir: ${files.join(', ')}`);
          
          // Search for downloaded video file with various extensions
          const videoExtensions = ['.mp4', '.mkv', '.webm', '.unknown_video', '.avi', '.flv', '.m4v'];
          let downloadedFile = files.find(f => 
            f.startsWith(filename.replace('.mp4', '')) && 
            videoExtensions.some(ext => f.endsWith(ext))
          );

          if (!downloadedFile) {
            logger.warn(`Download completed but no file found for ${strategy.name}`);
            continue;
          }
          
          // If file has .unknown_video extension, rename it to .mp4
          if (downloadedFile.endsWith('.unknown_video')) {
            const oldPath = path.join(config.download.tempDir, downloadedFile);
            const newFilename = downloadedFile.replace('.unknown_video', '.mp4');
            const newPath = path.join(config.download.tempDir, newFilename);
            await fs.rename(oldPath, newPath);
            downloadedFile = newFilename;
            logger.info(`Renamed .unknown_video to .mp4: ${newFilename}`);
          }

          downloadedFilePath = path.join(config.download.tempDir, downloadedFile);
          
          // Re-encode if VP9/HEVC slipped through
          try {
            const { stdout: codecStdout } = await execFile('ffprobe', [
              '-v', 'error',
              '-select_streams', 'v:0',
              '-show_entries', 'stream=codec_name',
              '-of', 'default=noprint_wrappers=1:nokey=1',
              downloadedFilePath
            ], { encoding: 'utf8', timeout: 5000, signal: options.signal });
            const codecName = (codecStdout || '').trim().toLowerCase();
            
            logger.info(`Video codec: ${codecName}`);
            
            const needsReencode = codecName.includes('vp9') || 
                                  codecName.includes('vp09') || 
                                  codecName.includes('hevc') || 
                                  codecName.includes('hvc1');
            
            if (needsReencode) {
              logger.warn(`Incompatible codec (${codecName}), re-encoding to H.264...`);
              
              const reencoded = downloadedFilePath.replace(/\.(mp4|mkv|webm)$/, '_h264.mp4');
              
              await execFile('ffmpeg', [
                '-i', downloadedFilePath,
                '-c:v', 'libx264',
                '-profile:v', 'baseline',
                '-level', '4.1',
                '-preset', 'veryfast',
                '-crf', '23',
                '-c:a', 'aac',
                '-profile:a', 'aac_low',
                '-b:a', '128k',
                '-movflags', '+faststart',
                reencoded
              ], { timeout: 120000, signal: options.signal });
              
              await fs.unlink(downloadedFilePath);
              await fs.rename(reencoded, downloadedFilePath);
              
              logger.info('Re-encoding complete');
            }
          } catch (codecError) {
            if (options.signal?.aborted) throw new Error('DOWNLOAD_CANCELLED');
            logger.warn(`Codec check failed: ${codecError.message} - continuing anyway`);
          }
          
          const stats = await fs.stat(downloadedFilePath);
          const fileSizeMB = stats.size / (1024 * 1024);
          
          logger.info(`Downloaded ${strategy.name}: ${fileSizeMB.toFixed(2)}MB`);

          if (stats.size <= maxSizeBytes) {
            usedQuality = strategy.name;
            logger.info(`Successfully downloaded in ${strategy.name} (${fileSizeMB.toFixed(2)}MB)`);
            break;
          } else {
            logger.info(`File too large (${fileSizeMB.toFixed(2)}MB), trying lower quality...`);
          }
        } catch (error) {
          if (options.signal?.aborted || error.message === 'DOWNLOAD_CANCELLED') {
            throw new Error('DOWNLOAD_CANCELLED');
          }
          logger.warn(`Failed to download with ${strategy.name}: ${error.message}`);
        }
      }

      if (!downloadedFilePath) {
        if (lastYtdlpError) {
          let m = lastYtdlpError.match(/ERROR:\s*\[.*?\][^:]*:\s*(.*)/i);
          if (!m) m = lastYtdlpError.match(/ERROR:\s*(.*)/i);
          if (m && m[1]) {
            throw new Error(`YTDLP_ERROR:${m[1].trim()}`);
          }
          throw new Error(`YTDLP_ERROR:${lastYtdlpError.trim()}`);
        }
        throw new Error('Failed to download video: no file was created.');
      }

      const stats = await fs.stat(downloadedFilePath);
      if (stats.size > maxSizeBytes) {
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        throw new Error(
          `This video is too large to send via Telegram.\n\n` +
          `Even at lowest quality: ${fileSizeMB}MB\n` +
          `Telegram limit: ${config.download.maxFileSizeMB}MB\n\n` +
          `💡 Try a shorter video or use a different platform`
        );
      }

      let thumbnailDownloaded = null;
      try {
        const files = await fs.readdir(config.download.tempDir);
        const videoBasename = path.basename(downloadedFilePath, path.extname(downloadedFilePath));
        const thumbFile = files.find(f => 
          f.startsWith(videoBasename) && 
          (f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png') || f.endsWith('.webp'))
        );
        
        if (thumbFile) {
          const rawThumbPath = path.join(config.download.tempDir, thumbFile);
          logger.info(`Found raw thumbnail: ${thumbFile}`);
          // Process through prepareThumbnail to meet Telegram's 320px/200KB limits
          thumbnailDownloaded = await prepareThumbnail(rawThumbPath);
          // Clean up the raw thumbnail if a new one was created
          if (thumbnailDownloaded && thumbnailDownloaded !== rawThumbPath) {
            await fs.unlink(rawThumbPath).catch(() => {});
          }
        }
      } catch (error) {
        logger.warn(`Could not find/process thumbnail: ${error.message}`);
      }

      // If no thumbnail was found from yt-dlp, generate one from the video
      if (!thumbnailDownloaded) {
        logger.info('No thumbnail from yt-dlp, generating from video...');
        thumbnailDownloaded = await generateThumbnailFromVideo(downloadedFilePath);
      }

      let width = 1280, height = 720, duration = 0, title = 'Video', author = 'Unknown';
      
      try {
        const fullInfoPath = downloadedFilePath.substring(0, downloadedFilePath.lastIndexOf('.')) + '.info.json';
        const infoJsonExists = await fs.access(fullInfoPath).then(() => true).catch(() => false);
        
        if (infoJsonExists) {
          const infoJson = JSON.parse(await fs.readFile(fullInfoPath, 'utf8'));
          if (infoJson.title) title = infoJson.title;
          if (infoJson.uploader || infoJson.channel || infoJson.creator) {
            author = infoJson.uploader || infoJson.channel || infoJson.creator;
          }
          if (infoJson.duration) duration = infoJson.duration;
          
          try { await fs.unlink(fullInfoPath); } catch {}
        }
      } catch (e) {
        logger.warn(`Could not read info.json: ${e.message}`);
      }

      try {
        const { stdout: metadata } = await execFile('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height,duration:format=duration',
          '-show_entries', 'format_tags=title,artist,author,uploader,creator',
          '-of', 'json',
          downloadedFilePath
        ], { encoding: 'utf8', timeout: 5000, signal: options.signal });
        const parsed = JSON.parse(metadata);
        
        if (parsed.streams && parsed.streams[0]) {
          width = parsed.streams[0].width || width;
          height = parsed.streams[0].height || height;
          duration = parseFloat(parsed.streams[0].duration) || duration;
        }
        
        if (!duration && parsed.format && parsed.format.duration) {
          duration = parseFloat(parsed.format.duration);
        }
        
        if (parsed.format && parsed.format.tags) {
          if (parsed.format.tags.title && title === 'Video') {
            title = parsed.format.tags.title;
          }
          
          if (author === 'Unknown') {
            author = parsed.format.tags.artist || 
                     parsed.format.tags.author || 
                     parsed.format.tags.uploader || 
                     parsed.format.tags.creator || 
                     'Unknown';
          }
          
          const byMatch = title.match(/(?:Video|Post|Reel)\s+by\s+(.+)$/i);
          if (byMatch && author === 'Unknown') {
            author = byMatch[1];
          }
        }
      } catch (error) {
        logger.warn(`Could not get video metadata: ${error.message}`);
      }

      let fileSize = 0;
      try {
        const stats = await fs.stat(downloadedFilePath);
        fileSize = stats.size;
      } catch (error) {
        logger.warn(`Could not get file size: ${error.message}`);
      }

      return {
        filePath: downloadedFilePath,
        filename: path.basename(downloadedFilePath),
        thumbnailPath: thumbnailDownloaded,
        width: width,
        height: height,
        duration: duration,
        fileSize: fileSize,
        info: {
          title: title,
          author: author,
          duration: duration ? formatDuration(duration) : 'Unknown',
          fileSize: formatFileSize(fileSize),
          platform: this.extractPlatform(url),
          quality: usedQuality
        }
      };
    } catch (error) {
      if (error.message === 'DOWNLOAD_CANCELLED' || options.signal?.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }

      logger.error('Video download error:', error);
      
      if (error.message.includes('Unsupported URL')) {
        throw new Error('This platform or URL is not supported');
      } else if (error.message.includes('Private video')) {
        throw new Error('This video is private or requires authentication');
      } else if (error.message.includes('Video unavailable')) {
        throw new Error('Video is unavailable or has been removed');
      } else if (error.message.startsWith('YTDLP_ERROR:')) {
        let cleanError = error.message.replace('YTDLP_ERROR:', '').trim();
        cleanError = cleanError.split(/(?<=[.!?])\s+/)
          .filter(sentence => {
            const s = sentence.toLowerCase();
            return !s.includes('--cookies') && !s.includes('yt-dlp') && !s.includes('github.com');
          })
          .join(' ')
          .trim();
        throw new Error('Download failed - ' + cleanError);
      } else if (error.message.includes('too large to send via Telegram')) {
        throw error;
      } else if (error.message.includes('Downloaded file not found')) {
        throw new Error('Download failed - no video file was created. This may be caused by:\n• Site blocking automated downloads\n• Network/firewall blocking access\n• Rate limiting\n• Unsupported video format\n\nPlease try again later or use a different video.');
      }
      
      throw new Error(`Download failed: ${error.message}`);
    }
  }

  
  extractPlatform(url) {
    try {
      const hostname = new URL(url).hostname;
      
      if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'YouTube';
      if (hostname.includes('tiktok.com')) return 'TikTok';
      if (hostname.includes('instagram.com')) return 'Instagram';
      if (hostname.includes('twitter.com') || hostname.includes('x.com')) return 'Twitter';
      if (hostname.includes('facebook.com') || hostname.includes('fb.watch')) return 'Facebook';
      if (hostname.includes('vimeo.com')) return 'Vimeo';
      if (hostname.includes('reddit.com')) return 'Reddit';
      if (hostname.includes('twitch.tv')) return 'Twitch';
      if (hostname.includes('bsky.app')) return 'Bluesky';
      
      const parts = hostname.split('.');
      const domain = parts[parts.length - 2] || parts[0];
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    } catch (error) {
      return 'Unknown';
    }
  }



  async downloadTikTokSlideshow(url, options = {}, onProgress = null) {
    if (typeof options === 'function') {
      onProgress = options;
      options = {};
    }
    return await tiktokService.downloadTikTokSlideshow(url, options, onProgress);
  }

  /**
   * Download Instagram post (photos/videos) using instagram-url-direct
   * Delegates to instagramService for the actual download
   */
  async downloadInstagramPost(url, imgIndex = null, options = {}, onProgress = null) {
    if (typeof options === 'function') {
      onProgress = options;
      options = {};
    }
    return await instagramService.downloadInstagramPost(url, imgIndex, options, onProgress);
  }

  /**
   * Download Bluesky post (video/images) using the AT Protocol API
   * Delegates to blueskyService for the actual download
   */
  async downloadBlueskyPost(url, options = {}, onProgress = null) {
    if (typeof options === 'function') {
      onProgress = options;
      options = {};
    }
    return await blueskyService.downloadBlueskyPost(url, options, onProgress);
  }
}

module.exports = new VideoService();
