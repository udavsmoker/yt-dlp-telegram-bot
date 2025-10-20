const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

class PhotoDatabaseService {
  constructor() {
    this.db = null;
    this.maxPhotosPerChat = 100;
  }

  init() {
    try {
      const dbPath = path.join(__dirname, '../../data/photos.db');
      this.db = new Database(dbPath);
      
      // Create photos table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS photos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          file_id TEXT NOT NULL,
          file_unique_id TEXT NOT NULL,
          width INTEGER,
          height INTEGER,
          file_size INTEGER,
          message_id INTEGER,
          timestamp INTEGER NOT NULL,
          has_caption INTEGER DEFAULT 0,
          caption TEXT
        )
      `);

      // Create index for faster queries
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_timestamp 
        ON photos(chat_id, timestamp DESC)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_message 
        ON photos(chat_id, message_id)
      `);

      logger.info('Photo database initialized');
    } catch (error) {
      logger.error('Failed to initialize photo database:', error);
      throw error;
    }
  }

  savePhoto(chatId, userId, photo, messageId, caption = null) {
    try {
      const key = String(chatId);
      
      // Get the largest photo size (best quality)
      const largestPhoto = photo[photo.length - 1];
      
      const stmt = this.db.prepare(`
        INSERT INTO photos (
          chat_id, user_id, file_id, file_unique_id, 
          width, height, file_size, message_id, 
          timestamp, has_caption, caption
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        key,
        String(userId),
        largestPhoto.file_id,
        largestPhoto.file_unique_id,
        largestPhoto.width || 0,
        largestPhoto.height || 0,
        largestPhoto.file_size || 0,
        messageId,
        Date.now(),
        caption ? 1 : 0,
        caption
      );

      // Cleanup old photos if exceeds limit
      this.cleanupOldPhotos(key);

      logger.debug(`Photo saved for chat ${chatId}, message ${messageId}`);
    } catch (error) {
      logger.error('Failed to save photo:', error);
    }
  }

  cleanupOldPhotos(chatId) {
    try {
      const count = this.db.prepare(
        'SELECT COUNT(*) as count FROM photos WHERE chat_id = ?'
      ).get(chatId)?.count || 0;

      if (count > this.maxPhotosPerChat) {
        const toDelete = count - this.maxPhotosPerChat;
        
        // Delete oldest photos
        this.db.prepare(`
          DELETE FROM photos 
          WHERE id IN (
            SELECT id FROM photos 
            WHERE chat_id = ? 
            ORDER BY timestamp ASC 
            LIMIT ?
          )
        `).run(chatId, toDelete);

        logger.debug(`Cleaned up ${toDelete} old photos for chat ${chatId}`);
      }
    } catch (error) {
      logger.error('Failed to cleanup old photos:', error);
    }
  }

  getRandomPhoto(chatId) {
    try {
      const key = String(chatId);
      const photo = this.db.prepare(`
        SELECT * FROM photos 
        WHERE chat_id = ? 
        ORDER BY RANDOM() 
        LIMIT 1
      `).get(key);

      return photo || null;
    } catch (error) {
      logger.error('Failed to get random photo:', error);
      return null;
    }
  }

  getPhotoByMessageId(chatId, messageId) {
    try {
      const key = String(chatId);
      const photo = this.db.prepare(`
        SELECT * FROM photos 
        WHERE chat_id = ? AND message_id = ? 
        LIMIT 1
      `).get(key, messageId);

      return photo || null;
    } catch (error) {
      logger.error('Failed to get photo by message ID:', error);
      return null;
    }
  }

  getPhotoCount(chatId) {
    try {
      const key = String(chatId);
      const result = this.db.prepare(
        'SELECT COUNT(*) as count FROM photos WHERE chat_id = ?'
      ).get(key);

      return result?.count || 0;
    } catch (error) {
      logger.error('Failed to get photo count:', error);
      return 0;
    }
  }

  getRecentPhotos(chatId, limit = 10) {
    try {
      const key = String(chatId);
      const photos = this.db.prepare(`
        SELECT * FROM photos 
        WHERE chat_id = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `).all(key, limit);

      return photos;
    } catch (error) {
      logger.error('Failed to get recent photos:', error);
      return [];
    }
  }

  deletePhotosByChat(chatId) {
    try {
      const key = String(chatId);
      const stmt = this.db.prepare('DELETE FROM photos WHERE chat_id = ?');
      stmt.run(key);
      logger.info(`Deleted all photos for chat ${chatId}`);
    } catch (error) {
      logger.error('Failed to delete photos:', error);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = new PhotoDatabaseService();
