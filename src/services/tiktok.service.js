const TiktokDL = require('@tobyg74/tiktok-api-dl');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { generateFilename, ensureDir } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');

class TikTokService {
  async downloadTikTokSlideshow(url) {
    try {
      logger.info(`Downloading TikTok content using @tobyg74/tiktok-api-dl: ${url}`);
      
      await ensureDir(config.download.tempDir);

      let result;
      let version = 'v1';
      
      try {
        result = await TiktokDL.Downloader(url, { version: "v1" });
      } catch (v1Error) {
        logger.warn(`v1 API failed, trying v3: ${v1Error.message}`);
        version = 'v3';
        result = await TiktokDL.Downloader(url, { version: "v3" });
      }

      logger.info(`TikTok API response status: ${result.status} (using ${version})`);

      if (result.status !== 'success') {
        throw new Error(`TikTok API error: ${result.message || 'Unknown error'}`);
      }

      const data = result.result;
      
      logger.info(`TikTok data type: ${data.type}`);
      logger.info(`Available keys: ${Object.keys(data).join(', ')}`);
      logger.info(`Full result structure: ${JSON.stringify(Object.keys(result), null, 2)}`);
      
      if (data.music_info) {
        logger.info(`music_info keys: ${Object.keys(data.music_info).join(', ')}`);
      }
      if (data.author) {
        logger.info(`author keys: ${Object.keys(data.author).join(', ')}`);
      }
      
      if (data.type !== 'image') {
        throw new Error('Not a photo slideshow');
      }

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
        audioPath: null, // Audio not supported for slideshows
        info: {
          title: data.title || data.desc || data.description || result.title || result.desc || 'TikTok Slideshow',
          author: data.author?.nickname || data.author?.unique_id || data.author?.name || result.author?.nickname || result.author?.unique_id || 'Unknown',
          platform: 'TikTok'
        }
      };
    } catch (error) {
      logger.error('TikTok slideshow download error:', error.message || error);
      throw error; // Re-throw to let handler catch it
    }
  }
}

module.exports = new TikTokService();
