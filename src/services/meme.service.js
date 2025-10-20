const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const markovDb = require('./markov-database.service');

class MemeService {
  constructor() {
    this.templatesDir = path.join(__dirname, '../../templates');
    this.outputDir = path.join(__dirname, '../../temp');
    this.templates = [];
  }

  async init() {
    try {
      // Ensure directories exist
      await fs.mkdir(this.templatesDir, { recursive: true });
      await fs.mkdir(this.outputDir, { recursive: true });
      
      // Load templates
      await this.loadTemplates();
      
      logger.info(`Meme service initialized with ${this.templates.length} templates`);
    } catch (error) {
      logger.error(`Error initializing meme service: ${error.message}`);
    }
  }

  async loadTemplates() {
    try {
      const files = await fs.readdir(this.templatesDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      this.templates = [];
      
      for (const jsonFile of jsonFiles) {
        try {
          const jsonPath = path.join(this.templatesDir, jsonFile);
          const data = await fs.readFile(jsonPath, 'utf8');
          const template = JSON.parse(data);
          
          // Validate template has required fields
          if (!template.name || !template.textBoxes) {
            logger.warn(`Invalid template: ${jsonFile} - missing required fields`);
            continue;
          }
          
          // Support multiple images: folder or single file or array
          let imagePaths = [];
          
          // Check if template.image is a folder
          if (template.image) {
            const imagePathOrFolder = path.join(this.templatesDir, template.image);
            try {
              const stats = await fs.stat(imagePathOrFolder);
              if (stats.isDirectory()) {
                // It's a folder - load all images from it
                const folderFiles = await fs.readdir(imagePathOrFolder);
                const imageFiles = folderFiles.filter(f => 
                  f.match(/\.(jpg|jpeg|png|gif|webp)$/i)
                );
                imagePaths = imageFiles.map(f => path.join(imagePathOrFolder, f));
                logger.info(`Template ${template.name}: found ${imagePaths.length} images in folder`);
              } else {
                // Single file
                imagePaths = [imagePathOrFolder];
              }
            } catch {
              logger.warn(`Template image not found: ${template.image}`);
              continue;
            }
          }
          
          // Check for pattern: template_name1.jpg, template_name2.jpg, etc.
          if (imagePaths.length === 0) {
            const baseName = template.name;
            const matchingFiles = files.filter(f => 
              f.match(new RegExp(`^${baseName}\\d*\\.(jpg|jpeg|png|gif|webp)$`, 'i'))
            );
            
            if (matchingFiles.length > 0) {
              imagePaths = matchingFiles.map(f => path.join(this.templatesDir, f));
              logger.info(`Template ${template.name}: found ${imagePaths.length} images by pattern`);
            }
          }
          
          if (imagePaths.length === 0) {
            logger.warn(`No images found for template: ${template.name}`);
            continue;
          }
          
          template.imagePaths = imagePaths;
          this.templates.push(template);
          logger.info(`Loaded template: ${template.name} with ${imagePaths.length} image(s)`);
        } catch (error) {
          logger.error(`Error loading template ${jsonFile}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`Error loading templates: ${error.message}`);
    }
  }

  // Generate meme with random messages from chat
  async generateMeme(chatId, templateName = null) {
    try {
      if (this.templates.length === 0) {
        throw new Error('No templates available. Add templates to the templates/ directory.');
      }

      // Select template (random or by name)
      let template;
      if (templateName) {
        template = this.templates.find(t => t.name.toLowerCase() === templateName.toLowerCase());
        if (!template) {
          throw new Error(`Template "${templateName}" not found`);
        }
      } else {
        template = this.templates[Math.floor(Math.random() * this.templates.length)];
      }

      // Pick random image from template's images
      const randomImagePath = template.imagePaths[
        Math.floor(Math.random() * template.imagePaths.length)
      ];

      // Get random messages for text boxes
      const messages = [];
      for (let i = 0; i < template.textBoxes.length; i++) {
        const box = template.textBoxes[i];
        let message;
        
        if (box.useSassyMessages) {
          // Get sassy messages if requested
          const sassyMessages = markovDb.getSassyMessages(chatId, 50);
          if (sassyMessages.length > 0) {
            message = sassyMessages[Math.floor(Math.random() * sassyMessages.length)];
          }
        }
        
        // Fallback to random message
        if (!message) {
          message = markovDb.getRandomMessage(chatId);
        }
        
        if (!message) {
          throw new Error('Not enough messages in database to generate meme');
        }
        
        messages.push(message);
      }

      // Generate image with random image path
      const outputPath = await this.renderMeme(randomImagePath, template, messages);
      
      return {
        filePath: outputPath,
        templateName: template.name,
        messages: messages
      };
    } catch (error) {
      logger.error(`Error generating meme: ${error.message}`);
      throw error;
    }
  }

  // Render meme with text on image
  async renderMeme(imagePath, template, messages) {
    try {
      // Load base image (from randomly selected path)
      const image = await loadImage(imagePath);
      
      logger.info(`Rendering meme: image size ${image.width}x${image.height}`);
      
      // Create canvas
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      
      // Draw base image
      ctx.drawImage(image, 0, 0);
      
      // Draw text boxes
      for (let i = 0; i < template.textBoxes.length && i < messages.length; i++) {
        const box = template.textBoxes[i];
        const text = messages[i];
        
        // Auto-position if needed
        const positionedBox = this.calculatePosition(box, i, image.width, image.height);
        
        logger.info(`Box ${i}: x=${positionedBox.x}, y=${positionedBox.y}, width=${positionedBox.width}, align=${positionedBox.align}, _autoPositioned=${positionedBox._autoPositioned}`);
        
        this.drawTextBox(ctx, text, positionedBox, i);
      }
      
      // Save to file
      const filename = `meme_${Date.now()}_${Math.random().toString(36).substring(7)}.png`;
      const outputPath = path.join(this.outputDir, filename);
      const buffer = canvas.toBuffer('image/png');
      await fs.writeFile(outputPath, buffer);
      
      logger.info(`Generated meme: ${filename} using template ${template.name}`);
      return outputPath;
    } catch (error) {
      logger.error(`Error rendering meme: ${error.message}`);
      throw error;
    }
  }

  // Calculate text position (auto or manual)
  calculatePosition(box, index, imageWidth, imageHeight) {
    // If box has manual coordinates, use them (but allow percentage strings)
    if (box.x !== undefined && box.y !== undefined) {
      const manual = { ...box };
      // Convert percentage strings to pixel values for x, y and width
      if (typeof manual.x === 'string' && manual.x.trim().endsWith('%')) {
        const pct = parseFloat(manual.x) / 100;
        manual.x = Math.round(pct * imageWidth);
      }
      if (typeof manual.y === 'string' && manual.y.trim().endsWith('%')) {
        const pct = parseFloat(manual.y) / 100;
        manual.y = Math.round(pct * imageHeight);
      }
      if (manual.width && typeof manual.width === 'string' && manual.width.trim().endsWith('%')) {
        const pct = parseFloat(manual.width) / 100;
        manual.width = Math.round(pct * imageWidth);
      }
      return manual;
    }

  // Auto-positioning logic
  // Compute a scaling factor so text scales with image size
  // Baseline reference: 1200x800 images (common for memes)
  const refWidth = 1200;
  const refHeight = 800;
  const scale = Math.min(imageWidth / refWidth, imageHeight / refHeight);

  // Dynamic paddings based on image height (roughly 6% margin)
  const topPadding = Math.round(imageHeight * 0.06);
  const bottomPadding = Math.round(imageHeight * 0.06);

    const positionedBox = { ...box };
    
  // Mark as auto-positioned so drawTextBox knows x is already the center
  positionedBox._autoPositioned = true;
  positionedBox._scale = (box.scaleWithImage === false) ? 1 : scale;

    // First text box goes to top, second to bottom
    if (index === 0) {
      // Top center
      positionedBox.x = imageWidth / 2;
      positionedBox.y = topPadding;
      positionedBox.align = 'center';
    } else {
      // Bottom center - textBaseline will be 'bottom' so y is the bottom edge
      positionedBox.x = imageWidth / 2;
      positionedBox.y = imageHeight - bottomPadding;
      positionedBox.align = 'center';
    }

    // Default width to 90% of image width if not specified
    if (!positionedBox.width) {
      positionedBox.width = imageWidth * 0.9;
    }

    return positionedBox;
  }

  // Draw text in a box with word wrapping and styling
  drawTextBox(ctx, text, box, index = 0) {
    try {
      // Set default values
      const x = box.x || 0;
      const y = box.y || 0;
      const width = box.width || 500;
      const maxLines = box.maxLines || 10;
      const baseFontSize = box.fontSize || 40;
      const scale = box._scale || 1;
      const fontSize = Math.max(12, Math.round(baseFontSize * scale));
      const fontFamily = box.fontFamily || 'Impact, Arial';
      const color = box.color || '#FFFFFF';
      const strokeColor = box.strokeColor || '#000000';
      const baseStroke = (box.strokeWidth || 3);
      const strokeWidth = Math.max(1, Math.round(baseStroke * scale));
      const align = box.align || 'center';
      const baseLineHeight = box.lineHeight || baseFontSize * 1.2;
      const lineHeight = Math.max(12, Math.round(baseLineHeight * scale));
      const uppercase = box.uppercase !== false; // Default true
      
  logger.info(`drawTextBox: x=${x}, y=${y}, width=${width}, align=${align}, _autoPositioned=${box._autoPositioned}, scale=${scale}, fontSize=${fontSize}, strokeWidth=${strokeWidth}, lineHeight=${lineHeight}`);
      
      // Configure font
      ctx.font = `${fontSize}px ${fontFamily}`;
      ctx.fillStyle = color;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.textAlign = align;
      
      // For auto-positioned bottom text (index 1), use 'bottom' baseline so y is the bottom of text
      // For top text and manual positioning, use 'top' baseline
      if (box._autoPositioned && index === 1) {
        ctx.textBaseline = 'bottom';
      } else {
        ctx.textBaseline = 'top';
      }
      
      // Transform text
      let finalText = text;
      if (uppercase) {
        finalText = finalText.toUpperCase();
      }
      
      // Word wrap
      const words = finalText.split(' ');
      const lines = [];
      let currentLine = '';
      
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const metrics = ctx.measureText(testLine);
        
        if (metrics.width > width && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
        
        if (lines.length >= maxLines - 1 && currentLine) {
          break;
        }
      }
      
      if (currentLine && lines.length < maxLines) {
        lines.push(currentLine);
      }
      
      // Truncate if too many lines
      if (lines.length > maxLines) {
        lines.length = maxLines;
        lines[maxLines - 1] = lines[maxLines - 1].substring(0, lines[maxLines - 1].length - 3) + '...';
      }
      
      // Calculate X position based on alignment
      let textX = x;
      if (align === 'center') {
        // If auto-positioned, x is already the center point
        // Otherwise, x is the left edge and we need to offset
        if (box._autoPositioned) {
          textX = x;
        } else {
          textX = x + width / 2;
        }
      } else if (align === 'right') {
        textX = x + width;
      }
      
      // Draw each line
      for (let i = 0; i < lines.length; i++) {
        const lineY = y + (i * lineHeight);
        
        logger.info(`Drawing line ${i}: "${lines[i]}" at textX=${textX}, lineY=${lineY}`);
        
        // Draw stroke (outline)
        if (strokeWidth > 0) {
          ctx.strokeText(lines[i], textX, lineY);
        }
        
        // Draw fill
        ctx.fillText(lines[i], textX, lineY);
      }
    } catch (error) {
      logger.error(`Error drawing text box: ${error.message}`);
    }
  }

  // Get list of available templates
  getTemplateList() {
    return this.templates.map(t => ({
      name: t.name,
      description: t.description || 'No description',
      textBoxCount: t.textBoxes.length
    }));
  }

  // Reload templates from disk
  async reloadTemplates() {
    await this.loadTemplates();
    return this.templates.length;
  }
}

module.exports = new MemeService();
