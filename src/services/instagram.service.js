const { instagramGetUrl } = require('instagram-url-direct');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { generateFilename, ensureDir } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');

class InstagramService {
  /**
   * Download Instagram content (photos or video) from a post URL
   * Handles single images, carousels, and videos
   */
  async downloadInstagramPost(url) {
    try {
      logger.info(`Downloading Instagram post using instagram-url-direct: ${url}`);
      
      await ensureDir(config.download.tempDir);

      // Get direct URLs from Instagram
      const result = await instagramGetUrl(url);
      
      logger.info(`Instagram API response: results=${result.results_number}, owner=${result.post_info?.owner_username || 'unknown'}`);

      if (!result || (!result.url_list || result.url_list.length === 0) && (!result.media_details || result.media_details.length === 0)) {
        throw new Error('Failed to get Instagram media URLs');
      }

      // Use media_details if available (has explicit type info), otherwise fall back to url_list
      const mediaDetails = result.media_details || [];
      const filenamePrefix = generateFilename('insta', '');
      const downloadedMedia = [];
      
      // Get author info from post_info if available
      let author = result.post_info?.owner_username ? `@${result.post_info.owner_username}` : 'Unknown';

      // Count media types
      let imageCount = 0;
      let videoCount = 0;
      
      if (mediaDetails.length > 0) {
        // Use media_details for accurate type detection and order preservation
        for (const detail of mediaDetails) {
          if (detail.type === 'image') imageCount++;
          else if (detail.type === 'video') videoCount++;
        }
        logger.info(`Media details: ${imageCount} image(s), ${videoCount} video(s)`);
        
        // If only videos, fall back to yt-dlp for better quality
        if (imageCount === 0 && videoCount > 0) {
          logger.info('Only videos found in post, falling back to video download');
          return { type: 'video', shouldFallback: true };
        }
        
        // Download each media item in order
        for (let i = 0; i < mediaDetails.length; i++) {
          const detail = mediaDetails[i];
          const mediaUrl = detail.url;
          const mediaType = detail.type;
          
          if (!mediaUrl) {
            logger.warn(`No URL found for media ${i + 1}`);
            continue;
          }
          
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
            downloadedMedia.push({ 
              type: mediaType === 'video' ? 'video' : 'photo', 
              path: mediaPath 
            });
            logger.info(`Downloaded ${mediaType} ${i + 1}/${mediaDetails.length}`);
          } catch (downloadError) {
            logger.error(`Failed to download ${mediaType} ${i + 1}: ${downloadError.message}`);
          }
        }
      } else {
        // Fallback: use url_list with URL-based type detection
        const mediaUrls = result.url_list;
        logger.info(`Using url_list fallback: ${mediaUrls.length} item(s)`);
        
        for (let i = 0; i < mediaUrls.length; i++) {
          const mediaUrl = mediaUrls[i];
          // Detect type from URL
          const isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('/video/') || mediaUrl.includes('video_dashinit');
          const ext = isVideo ? 'mp4' : 'jpg';
          const mediaPath = path.join(config.download.tempDir, `${filenamePrefix.replace(/\.$/, '')}_${i + 1}.${ext}`);
          
          if (isVideo) videoCount++;
          else imageCount++;
          
          try {
            const response = await axios({
              method: 'GET',
              url: mediaUrl,
              responseType: 'arraybuffer',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.instagram.com/'
              },
              timeout: isVideo ? 60000 : 30000,
              maxContentLength: 50 * 1024 * 1024
            });

            await fs.writeFile(mediaPath, response.data);
            downloadedMedia.push({ 
              type: isVideo ? 'video' : 'photo', 
              path: mediaPath 
            });
            logger.info(`Downloaded media ${i + 1}/${mediaUrls.length} (${isVideo ? 'video' : 'image'})`);
          } catch (downloadError) {
            logger.error(`Failed to download media ${i + 1}: ${downloadError.message}`);
          }
        }
        
        // If only videos, fall back to yt-dlp
        if (imageCount === 0 && videoCount > 0 && downloadedMedia.length === 0) {
          logger.info('Only videos found in post, falling back to video download');
          return { type: 'video', shouldFallback: true };
        }
      }

      if (downloadedMedia.length === 0) {
        throw new Error('Failed to download any media from the post');
      }

      return {
        type: 'mixed', // Can contain photos and videos
        media: downloadedMedia,
        imagePaths: downloadedMedia.filter(m => m.type === 'photo').map(m => m.path),
        videoPaths: downloadedMedia.filter(m => m.type === 'video').map(m => m.path),
        info: {
          title: 'Instagram Post',
          author: author,
          platform: 'Instagram',
          imageCount: downloadedMedia.filter(m => m.type === 'photo').length,
          videoCount: downloadedMedia.filter(m => m.type === 'video').length
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
