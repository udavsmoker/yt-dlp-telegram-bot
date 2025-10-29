const { createCanvas, loadImage } = require('canvas');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const logger = require('../utils/logger');
const markovDb = require('./markov-database.service');
const photoDb = require('./photo-database.service');

class DemotivatorService {
  constructor() {
    this.tempDir = path.join(__dirname, '../../temp');
  }

  async init() {
    try {
      // Ensure temp directory exists
      await fs.mkdir(this.tempDir, { recursive: true });
      logger.info('Demotivator service initialized');
    } catch (error) {
      logger.error('Failed to initialize demotivator service:', error);
    }
  }

  /**
   * Generate a demotivator image
   * @param {string} chatId - Chat ID for message/photo selection
   * @param {string} fileId - Optional file_id for specific photo (from reply)
   * @param {object} telegram - Telegraf Telegram API instance (ctx.telegram)
   * @returns {Promise<{filePath: string, photoInfo: object, text: string}>}
   */
  async generateDemotivator(chatId, fileId = null, telegram = null) {
    let tempImagePath = null;

    try {
      // Get photo
      let photoData;
      if (fileId) {
        // Use specific photo from reply
        photoData = { file_id: fileId };
      } else {
        // Get random photo from database
        photoData = photoDb.getRandomPhoto(chatId);
        if (!photoData) {
          const photoCount = photoDb.getPhotoCount(chatId);
          logger.error(`No photos found for chat ${chatId}. Total photos in DB: ${photoCount}`);
          throw new Error('No photos available. Send some photos to the chat first!');
        }
        logger.info(`Selected random photo for chat ${chatId}, file_id: ${photoData.file_id}`);
      }

      // Download photo from Telegram
      if (!telegram) {
        throw new Error('Telegram API instance required for downloading photos');
      }

      const fileLink = await telegram.getFileLink(photoData.file_id);
      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      
      // Save temporary image
      tempImagePath = path.join(this.tempDir, `demotivator_temp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.jpg`);
      await fs.writeFile(tempImagePath, response.data);

      // Load the image
      const sourceImage = await loadImage(tempImagePath);

      // Get random message(s) for text - randomly 1 or 2 texts
      const useDoubleText = Math.random() < 0.5; // 50% chance for 2 texts
      const messageText1 = markovDb.getRandomMessage(chatId);
      if (!messageText1) {
        throw new Error('No messages available for demotivator text');
      }

      let messageText2 = null;
      if (useDoubleText) {
        messageText2 = markovDb.getRandomMessage(chatId);
      }

      // Generate demotivator
      const resultPath = await this.renderDemotivator(sourceImage, messageText1, messageText2);

      return {
        filePath: resultPath,
        photoInfo: photoData,
        text: messageText2 ? `${messageText1} / ${messageText2}` : messageText1
      };
    } catch (error) {
      logger.error('Failed to generate demotivator:', error);
      throw error;
    } finally {
      // Cleanup temp image
      if (tempImagePath) {
        try {
          await fs.unlink(tempImagePath);
        } catch (err) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Render demotivator in classic Russian style
   * Black background, centered image with border, title below
   * @param {Image} sourceImage - The image to use
   * @param {string} text1 - Main text (bigger)
   * @param {string} text2 - Optional second text (smaller)
   */
  async renderDemotivator(sourceImage, text1, text2 = null) {
    try {
      // Demotivator dimensions - FIXED SQUARE CANVAS
      const canvasSize = 800;
      
      // Border settings
      const outerBorder = 30;
      const whiteBorder = 2;
      const innerBlackBorder = 10;
      // Fixed SQUARE image area - image will be stretched to this size
      const imageSize = canvasSize - (outerBorder * 2) - (whiteBorder * 2) - (innerBlackBorder * 2) - 20;
      
      // Text area (below image)
      const textAreaHeight = 150; // Reserved space for text
      const totalCanvasHeight = canvasSize + textAreaHeight;
      
      // Create canvas
      const canvas = createCanvas(canvasSize, totalCanvasHeight);
      const ctx = canvas.getContext('2d');
      
      // Fill black background
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvasSize, totalCanvasHeight);
      
      // Calculate image position (centered horizontally, near top)
      const imageX = (canvasSize - imageSize) / 2;
      const imageY = outerBorder + 10;
      
      // Draw white border around image
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(
        imageX - whiteBorder - innerBlackBorder,
        imageY - whiteBorder - innerBlackBorder,
        imageSize + (whiteBorder * 2) + (innerBlackBorder * 2),
        imageSize + (whiteBorder * 2) + (innerBlackBorder * 2)
      );
      
      // Draw inner black border (creates margin)
      ctx.fillStyle = '#000000';
      ctx.fillRect(
        imageX - innerBlackBorder,
        imageY - innerBlackBorder,
        imageSize + (innerBlackBorder * 2),
        imageSize + (innerBlackBorder * 2)
      );
      
      // Draw the image STRETCHED to SQUARE
      ctx.drawImage(sourceImage, imageX, imageY, imageSize, imageSize);
      
      // Draw text below image with dynamic sizing
      let textY = imageY + imageSize + 40;
      const textMaxWidth = canvasSize - (outerBorder * 2) - 40;
      
      // Draw first text (bigger, main text) with dynamic font sizing
      const { fontSize: fontSize1, lines: lines1 } = this.fitText(ctx, text1, textMaxWidth, textAreaHeight * 0.6, 36, 20, 2);
      
      ctx.font = `${fontSize1}px "Times New Roman"`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      
      const lineHeight1 = fontSize1 + 6;
      
      lines1.forEach((line, index) => {
        const y = textY + (index * lineHeight1);
        ctx.fillText(line, canvasSize / 2, y);
      });
      
      // Draw second text if provided (smaller, subtitle) with dynamic sizing
      if (text2) {
        textY += lines1.length * lineHeight1 + 10; // Add spacing
        const { fontSize: fontSize2, lines: lines2 } = this.fitText(ctx, text2, textMaxWidth, textAreaHeight * 0.4, 24, 16, 2);
        
        ctx.font = `${fontSize2}px "Times New Roman"`;
        ctx.fillStyle = '#ffffffff'; // Lighter gray color
        
        const lineHeight2 = fontSize2 + 4;
        
        lines2.forEach((line, index) => {
          const y = textY + (index * lineHeight2);
          ctx.fillText(line, canvasSize / 2, y);
        });
      }
      
      // Save to file
      const outputPath = path.join(
        this.tempDir,
        `demotivator_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.png`
      );
      
      const buffer = canvas.toBuffer('image/png');
      await fs.writeFile(outputPath, buffer);
      
      logger.debug(`Demotivator rendered: ${outputPath}`);
      return outputPath;
    } catch (error) {
      logger.error('Failed to render demotivator:', error);
      throw error;
    }
  }

  /**
   * Dynamically fit text by reducing font size until it fits within constraints
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {string} text - Text to fit
   * @param {number} maxWidth - Maximum width for text
   * @param {number} maxHeight - Maximum height for text block
   * @param {number} startFontSize - Starting font size
   * @param {number} minFontSize - Minimum font size to try
   * @param {number} maxLines - Maximum number of lines
   * @returns {{fontSize: number, lines: string[]}}
   */
  fitText(ctx, text, maxWidth, maxHeight, startFontSize, minFontSize, maxLines) {
    let fontSize = startFontSize;
    let lines = [];
    
    // Try progressively smaller font sizes until text fits
    while (fontSize >= minFontSize) {
      ctx.font = `${fontSize}px "Times New Roman"`;
      lines = this.wrapText(ctx, text, maxWidth, fontSize);
      
      // Check if it fits within maxLines
      if (lines.length <= maxLines) {
        const lineHeight = fontSize + 6;
        const totalHeight = lines.length * lineHeight;
        
        // Check if total height fits
        if (totalHeight <= maxHeight) {
          return { fontSize, lines };
        }
      }
      
      // Reduce font size and try again
      fontSize -= 2;
    }
    
    // If still doesn't fit, truncate to maxLines at minimum font size
    ctx.font = `${minFontSize}px "Times New Roman"`;
    lines = this.wrapText(ctx, text, maxWidth, minFontSize);
    return { fontSize: minFontSize, lines: lines.slice(0, maxLines) };
  }

  /**
   * Word wrap text to fit within maxWidth
   */
  wrapText(ctx, text, maxWidth, fontSize) {
    ctx.font = `${fontSize}px "Times New Roman"`;
    
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);
      
      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    return lines;
  }

  /**
   * Get statistics about stored photos
   */
  getPhotoStats(chatId) {
    const count = photoDb.getPhotoCount(chatId);
    const recent = photoDb.getRecentPhotos(chatId, 5);
    
    return {
      totalPhotos: count,
      recentPhotos: recent,
      maxPhotos: photoDb.maxPhotosPerChat
    };
  }
}

module.exports = new DemotivatorService();
