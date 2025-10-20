const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class SettingsService {
  constructor() {
    this.settingsFile = path.join(__dirname, '../../data/settings.json');
    this.settings = new Map();
    this.defaultSettings = {
      videoDownload: true,
      markovResponses: false,
      memeGeneration: false,
      demotivatorsEnabled: false,
      // Add more toggleable features here in the future:
      // tiktokSlideshow: true,
      // autoDelete: false,
      // etc.
    };
  }

  async init() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.settingsFile);
      await fs.mkdir(dataDir, { recursive: true });

      // Load existing settings
      try {
        const data = await fs.readFile(this.settingsFile, 'utf8');
        const settingsObj = JSON.parse(data);
        this.settings = new Map(Object.entries(settingsObj));
        logger.info(`Loaded settings for ${this.settings.size} chats`);
      } catch (error) {
        // File doesn't exist yet, start fresh
        logger.info('No existing settings file, starting fresh');
      }
    } catch (error) {
      logger.error('Failed to initialize settings:', error);
    }
  }

  async save() {
    try {
      const settingsObj = Object.fromEntries(this.settings);
      await fs.writeFile(this.settingsFile, JSON.stringify(settingsObj, null, 2));
      logger.debug('Settings saved successfully');
    } catch (error) {
      logger.error('Failed to save settings:', error);
    }
  }

  getSettings(chatId) {
    const key = String(chatId);
    if (!this.settings.has(key)) {
      // Return default settings for new chats
      return { ...this.defaultSettings };
    }
    // Merge with defaults to add any new features
    return { ...this.defaultSettings, ...this.settings.get(key) };
  }

  async toggleFeature(chatId, featureName) {
    const key = String(chatId);
    const current = this.getSettings(chatId);
    
    if (!(featureName in current)) {
      throw new Error(`Unknown feature: ${featureName}`);
    }

    current[featureName] = !current[featureName];
    this.settings.set(key, current);
    await this.save();

    logger.info(`Chat ${chatId}: ${featureName} = ${current[featureName]}`);
    return current[featureName];
  }

  async setFeature(chatId, featureName, value) {
    const key = String(chatId);
    const current = this.getSettings(chatId);
    
    if (!(featureName in current)) {
      throw new Error(`Unknown feature: ${featureName}`);
    }

    current[featureName] = Boolean(value);
    this.settings.set(key, current);
    await this.save();

    logger.info(`Chat ${chatId}: ${featureName} = ${current[featureName]}`);
    return current[featureName];
  }

  isFeatureEnabled(chatId, featureName) {
    const settings = this.getSettings(chatId);
    return settings[featureName] !== false; // Default to true if not set
  }

  // Get human-readable feature names and descriptions
  getFeatureInfo() {
    return {
      videoDownload: {
        name: '📹 Video Download',
        description: 'Download and send videos from supported platforms'
      },
      markovResponses: {
        name: '🤖 AI Chat Responses',
        description: 'Bot learns from messages and randomly responds with AI-generated text'
      },
      memeGeneration: {
        name: '🎨 Meme Generator',
        description: 'Generate memes using chat messages and custom templates'
      },
      demotivatorsEnabled: {
        name: '🖼️ Demotivators',
        description: 'Create Russian-style demotivators from chat photos and messages'
      },
      // Add more features here as you build them:
      // tiktokSlideshow: {
      //   name: '📸 TikTok Slideshows',
      //   description: 'Download TikTok photo slideshows'
      // },
    };
  }
}

module.exports = new SettingsService();
