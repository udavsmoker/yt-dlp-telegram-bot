const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class SettingsService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../data/settings.db');
    this.legacyJsonPath = path.join(__dirname, '../../data/settings.json');
    this.db = null;
    this.settings = new Map();
    this.defaultSettings = {
      videoDownload: true,
      markovResponses: false,
      memeGeneration: false,
      demotivatorsEnabled: false,
      blacklistEnabled: true,
    };
  }

  async init() {
    try {
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id TEXT PRIMARY KEY,
          settings_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      this.getStmt = this.db.prepare('SELECT settings_json FROM chat_settings WHERE chat_id = ?');
      this.setStmt = this.db.prepare(`
        INSERT INTO chat_settings (chat_id, settings_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `);
      this.getAllStmt = this.db.prepare('SELECT chat_id, settings_json FROM chat_settings');

      // Migrate existing settings.json if database is currently empty
      const count = this.db.prepare('SELECT COUNT(*) as count FROM chat_settings').get().count;
      if (count === 0 && fs.existsSync(this.legacyJsonPath)) {
        try {
          const raw = fs.readFileSync(this.legacyJsonPath, 'utf8');
          const legacyObj = JSON.parse(raw);
          const insertMany = this.db.transaction((items) => {
            const now = Date.now();
            for (const [chatId, s] of Object.entries(items)) {
              this.setStmt.run(String(chatId), JSON.stringify(s), now);
            }
          });
          insertMany(legacyObj);
          logger.info(`Migrated ${Object.keys(legacyObj).length} chat settings from JSON to SQLite`);
        } catch (migErr) {
          logger.error('Failed to migrate legacy settings.json to SQLite:', migErr);
        }
      }

      // Populate in-memory map for fast synchronous access
      const rows = this.getAllStmt.all();
      for (const row of rows) {
        try {
          this.settings.set(row.chat_id, JSON.parse(row.settings_json));
        } catch {}
      }
      logger.info(`Loaded settings for ${this.settings.size} chats from SQLite`);
    } catch (error) {
      logger.error('Failed to initialize settings SQLite database:', error);
    }
  }

  getSettings(chatId) {
    const key = String(chatId);
    if (!this.settings.has(key)) {
      return { ...this.defaultSettings };
    }
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
    this.saveChat(key, current);

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
    this.saveChat(key, current);

    logger.info(`Chat ${chatId}: ${featureName} = ${current[featureName]}`);
    return current[featureName];
  }

  saveChat(key, settingsObj) {
    if (!this.db || !this.setStmt) return;
    try {
      this.setStmt.run(key, JSON.stringify(settingsObj), Date.now());
    } catch (err) {
      logger.error(`Failed to persist settings for chat ${key}:`, err);
    }
  }

  isFeatureEnabled(chatId, featureName) {
    const settings = this.getSettings(chatId);
    return settings[featureName] !== false;
  }

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
      blacklistEnabled: {
        name: '🚫 Blacklist System',
        description: 'Block specific users from using bot commands (admin only)'
      }
    };
  }
}

module.exports = new SettingsService();
