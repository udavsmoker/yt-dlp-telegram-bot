const youtubedl = require('youtube-dl-exec');
const path = require('path');
const fs = require('fs').promises;
const { generateFilename, ensureDir } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');
const tiktokService = require('./tiktok.service');

class VideoService {
  constructor() {
    this.ytdlpPath = 'yt-dlp';
  }

  async download(url) {
    try {
      logger.info(`Starting download with yt-dlp: ${url}`);
      
      await ensureDir(config.download.tempDir);
      
      const filename = generateFilename('video', 'mp4');
      const outputTemplate = path.join(config.download.tempDir, filename.replace('.mp4', '.%(ext)s'));
      const thumbnailFilename = generateFilename('thumb', 'jpg');
      const thumbnailPath = path.join(config.download.tempDir, thumbnailFilename);

      const maxSizeBytes = config.download.maxFileSizeMB * 1024 * 1024;

      // iOS/Telegram compatibility: H.264/AVC + AAC audio, excludes VP9/HEVC
      const formatStrategies = [
        {
          name: 'best quality (H.264)',
          format: 'bv*[vcodec^=avc][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec!=vp9][vcodec!=vp09][vcodec!=hevc][vcodec!=hvc1][ext=mp4]+ba[ext=m4a]/b[vcodec^=avc][ext=mp4]/b[vcodec!=vp9][vcodec!=vp09][vcodec!=hevc]'
        },
        {
          name: '1080p (H.264)',
          format: 'bv*[vcodec^=avc][height<=1080][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec!=vp9][vcodec!=vp09][vcodec!=hevc][height<=1080][ext=mp4]+ba[ext=m4a]/b[vcodec^=avc][height<=1080][ext=mp4]/b[height<=1080]'
        },
        {
          name: '720p (H.264)',
          format: 'bv*[vcodec^=avc][height<=720][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec!=vp9][vcodec!=vp09][vcodec!=hevc][height<=720][ext=mp4]+ba[ext=m4a]/b[vcodec^=avc][height<=720][ext=mp4]/b[height<=720]'
        },
        {
          name: '480p (H.264)',
          format: 'bv*[vcodec^=avc][height<=480][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec!=vp9][vcodec!=vp09][vcodec!=hevc][height<=480][ext=mp4]+ba[ext=m4a]/b[vcodec^=avc][height<=480][ext=mp4]/b[height<=480]'
        },
        {
          name: '360p (H.264)',
          format: 'bv*[vcodec^=avc][height<=360][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec!=vp9][vcodec!=vp09][vcodec!=hevc][height<=360][ext=mp4]+ba[ext=m4a]/b[vcodec^=avc][height<=360][ext=mp4]/b[height<=360]'
        },
        {
          name: 'worst quality',
          format: 'wv*[vcodec!=vp9][vcodec!=vp09][vcodec!=hevc]+wa/w[vcodec!=vp9][vcodec!=vp09][vcodec!=hevc]/w'
        }
      ];

      let downloadedFilePath = null;
      let usedQuality = null;

      for (const strategy of formatStrategies) {
        try {
          logger.info(`Attempting download with ${strategy.name} format`);
          
          if (downloadedFilePath) {
            try {
              await fs.unlink(downloadedFilePath);
            } catch {}
          }

          await youtubedl(url, {
            output: outputTemplate,
            format: strategy.format,
            mergeOutputFormat: 'mp4',
            noWarnings: true,
            noCheckCertificates: true,
            preferFreeFormats: true,
            addMetadata: true,
            writeThumbnail: true,
            convertThumbnails: 'jpg',
          });

          const files = await fs.readdir(config.download.tempDir);
          const downloadedFile = files.find(f => 
            f.startsWith(filename.replace('.mp4', '')) && 
            (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
          );

          if (!downloadedFile) {
            continue;
          }

          downloadedFilePath = path.join(config.download.tempDir, downloadedFile);
          
          // Re-encode if VP9/HEVC slipped through
          try {
            const { execSync } = require('child_process');
            
            const codecName = execSync(
              `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${downloadedFilePath}"`,
              { encoding: 'utf8', timeout: 5000 }
            ).trim().toLowerCase();
            
            logger.info(`Video codec: ${codecName}`);
            
            const needsReencode = codecName.includes('vp9') || 
                                  codecName.includes('vp09') || 
                                  codecName.includes('hevc') || 
                                  codecName.includes('hvc1');
            
            if (needsReencode) {
              logger.warn(`Incompatible codec (${codecName}), re-encoding to H.264...`);
              
              const reencoded = downloadedFilePath.replace(/\.(mp4|mkv|webm)$/, '_h264.mp4');
              
              execSync(
                `ffmpeg -i "${downloadedFilePath}" -c:v libx264 -profile:v baseline -level 4.1 -preset veryfast -crf 23 -c:a aac -profile:a aac_low -b:a 128k -movflags +faststart "${reencoded}"`,
                { stdio: 'ignore', timeout: 120000 }
              );
              
              await fs.unlink(downloadedFilePath);
              await fs.rename(reencoded, downloadedFilePath);
              
              logger.info('Re-encoding complete');
            }
          } catch (codecError) {
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
          logger.warn(`Failed to download with ${strategy.name}: ${error.message}`);
        }
      }

      if (!downloadedFilePath) {
        throw new Error('Downloaded file not found');
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
          thumbnailDownloaded = path.join(config.download.tempDir, thumbFile);
          logger.info(`Found thumbnail: ${thumbFile}`);
        }
      } catch (error) {
        logger.warn(`Could not find thumbnail: ${error.message}`);
      }

      let width = 1280, height = 720, duration = 0, title = 'Video', author = 'Unknown';
      try {
        const { execSync } = require('child_process');
        const metadata = execSync(
          `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration:format=duration -show_entries format_tags=title,artist,author,uploader,creator -of json "${downloadedFilePath}"`,
          { encoding: 'utf8', timeout: 5000 }
        );
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
          if (parsed.format.tags.title) {
            title = parsed.format.tags.title;
          }
          
          author = parsed.format.tags.artist || 
                   parsed.format.tags.author || 
                   parsed.format.tags.uploader || 
                   parsed.format.tags.creator || 
                   'Unknown';
          
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
          duration: duration ? this.formatDuration(duration) : 'Unknown',
          fileSize: this.formatFileSize(fileSize),
          platform: this.extractPlatform(url),
          quality: usedQuality
        }
      };
    } catch (error) {
      logger.error('Video download error:', error);
      
      if (error.message.includes('Unsupported URL')) {
        throw new Error('This platform or URL is not supported');
      } else if (error.message.includes('Private video')) {
        throw new Error('This video is private or requires authentication');
      } else if (error.message.includes('Video unavailable')) {
        throw new Error('Video is unavailable or has been removed');
      } else if (error.message.includes('too large to send via Telegram')) {
        throw error;
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
      
      const parts = hostname.split('.');
      const domain = parts[parts.length - 2] || parts[0];
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    } catch (error) {
      return 'Unknown';
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
    if (!seconds) return 'Unknown';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  async downloadTikTokSlideshow(url) {
    return await tiktokService.downloadTikTokSlideshow(url);
  }
}

module.exports = new VideoService();
