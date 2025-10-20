const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

class MarkovDatabaseService {
  constructor() {
    const dbDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    this.db = new Database(path.join(dbDir, 'markov.db'));
    this.initDatabase();
    logger.info('Markov database initialized');
  }

  initDatabase() {
    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        message_text TEXT NOT NULL,
        reply_to_message_id INTEGER,
        timestamp INTEGER NOT NULL,
        has_question BOOLEAN DEFAULT 0,
        has_exclamation BOOLEAN DEFAULT 0,
        word_count INTEGER DEFAULT 0,
        UNIQUE(chat_id, timestamp, user_id)
      )
    `);

    // Personality settings per chat
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personality_settings (
        chat_id INTEGER PRIMARY KEY,
        laziness INTEGER DEFAULT 50,
        coherence INTEGER DEFAULT 50,
        sassiness INTEGER DEFAULT 50,
        markov_order INTEGER DEFAULT 2,
        silence_minutes INTEGER DEFAULT 15,
        updated_at INTEGER NOT NULL
      )
    `);

    // Index for faster queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON messages(chat_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_question ON messages(chat_id, has_question);
      CREATE INDEX IF NOT EXISTS idx_chat_exclamation ON messages(chat_id, has_exclamation);
    `);

    logger.info('Database schema initialized');
  }

  // Save incoming message
  saveMessage(chatId, userId, messageText, replyToMessageId = null) {
    try {
      // Check message count and cleanup if needed
      this.cleanupOldMessages(chatId);

      const timestamp = Date.now();
      const hasQuestion = messageText.includes('?') ? 1 : 0;
      const hasExclamation = messageText.includes('!') ? 1 : 0;
      const wordCount = messageText.split(/\s+/).length;

      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO messages 
        (chat_id, user_id, message_text, reply_to_message_id, timestamp, has_question, has_exclamation, word_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(chatId, userId, messageText, replyToMessageId, timestamp, hasQuestion, hasExclamation, wordCount);
      return true;
    } catch (error) {
      logger.error(`Error saving message: ${error.message}`);
      return false;
    }
  }

  // Cleanup old messages (keep max 50k per chat)
  cleanupOldMessages(chatId) {
    try {
      const count = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?').get(chatId);
      
      if (count && count.count > 50000) {
        this.db.prepare(`
          DELETE FROM messages 
          WHERE chat_id = ? 
          AND id NOT IN (
            SELECT id FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 50000
          )
        `).run(chatId, chatId);
        
        logger.info(`Cleaned up old messages for chat ${chatId}, kept 50k most recent`);
      }
    } catch (error) {
      logger.error(`Error cleaning up messages: ${error.message}`);
    }
  }

  // Get all messages for Markov training
  getMessagesForTraining(chatId, limit = 10000) {
    try {
      const stmt = this.db.prepare(`
        SELECT message_text 
        FROM messages 
        WHERE chat_id = ? AND word_count > 2
        ORDER BY timestamp DESC 
        LIMIT ?
      `);
      
      return stmt.all(chatId, limit).map(row => row.message_text);
    } catch (error) {
      logger.error(`Error getting messages for training: ${error.message}`);
      return [];
    }
  }

  // Get sassy messages (with punctuation)
  getSassyMessages(chatId, limit = 1000) {
    try {
      const stmt = this.db.prepare(`
        SELECT message_text 
        FROM messages 
        WHERE chat_id = ? AND (has_question = 1 OR has_exclamation = 1) AND word_count > 2
        ORDER BY RANDOM() 
        LIMIT ?
      `);
      
      return stmt.all(chatId, limit).map(row => row.message_text);
    } catch (error) {
      logger.error(`Error getting sassy messages: ${error.message}`);
      return [];
    }
  }

  // Get random message
  getRandomMessage(chatId) {
    try {
      const stmt = this.db.prepare(`
        SELECT message_text 
        FROM messages 
        WHERE chat_id = ? AND word_count > 2
        ORDER BY RANDOM() 
        LIMIT 1
      `);
      
      const result = stmt.get(chatId);
      return result ? result.message_text : null;
    } catch (error) {
      logger.error(`Error getting random message: ${error.message}`);
      return null;
    }
  }

  // Find similar messages by word overlap
  findSimilarMessages(chatId, inputText, limit = 50) {
    try {
      const inputWords = inputText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      
      if (inputWords.length === 0) return [];

      // Build LIKE conditions for each word
      const conditions = inputWords.map(() => 'LOWER(message_text) LIKE ?').join(' OR ');
      const params = inputWords.map(word => `%${word}%`);

      const stmt = this.db.prepare(`
        SELECT message_text 
        FROM messages 
        WHERE chat_id = ? AND (${conditions}) AND word_count > 2
        ORDER BY timestamp DESC
        LIMIT ?
      `);

      return stmt.all(chatId, ...params, limit).map(row => row.message_text);
    } catch (error) {
      logger.error(`Error finding similar messages: ${error.message}`);
      return [];
    }
  }

  // Get frequently used words (for keyword matching)
  getFrequentWords(chatId, limit = 100) {
    try {
      const messages = this.db.prepare(`
        SELECT message_text 
        FROM messages 
        WHERE chat_id = ? 
        ORDER BY timestamp DESC 
        LIMIT 5000
      `).all(chatId);

      // Count word frequency
      const wordCounts = {};
      const stopWords = new Set(['и', 'в', 'не', 'на', 'что', 'я', 'с', 'это', 'как', 'по', 'но', 'а', 'the', 'is', 'at', 'of', 'a', 'to', 'in']);

      messages.forEach(({ message_text }) => {
        const words = message_text.toLowerCase().match(/[а-яёa-z]{3,}/g) || [];
        words.forEach(word => {
          if (!stopWords.has(word)) {
            wordCounts[word] = (wordCounts[word] || 0) + 1;
          }
        });
      });

      // Sort by frequency
      return Object.entries(wordCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([word]) => word);
    } catch (error) {
      logger.error(`Error getting frequent words: ${error.message}`);
      return [];
    }
  }

  // Get last message timestamp in chat
  getLastMessageTime(chatId) {
    try {
      const stmt = this.db.prepare('SELECT MAX(timestamp) as last_time FROM messages WHERE chat_id = ?');
      const result = stmt.get(chatId);
      return result && result.last_time ? result.last_time : 0;
    } catch (error) {
      logger.error(`Error getting last message time: ${error.message}`);
      return 0;
    }
  }

  // Get message count for chat
  getMessageCount(chatId) {
    try {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?');
      const result = stmt.get(chatId);
      return result ? result.count : 0;
    } catch (error) {
      logger.error(`Error getting message count: ${error.message}`);
      return 0;
    }
  }

  // === Personality Settings ===

  getPersonalitySettings(chatId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM personality_settings WHERE chat_id = ?');
      const result = stmt.get(chatId);
      
      if (!result) {
        // Return defaults
        return {
          laziness: 50,
          coherence: 50,
          sassiness: 50,
          markov_order: 2,
          silence_minutes: 15
        };
      }
      
      return result;
    } catch (error) {
      logger.error(`Error getting personality settings: ${error.message}`);
      return { laziness: 50, coherence: 50, sassiness: 50, markov_order: 2, silence_minutes: 15 };
    }
  }

  updatePersonalitySetting(chatId, setting, value) {
    try {
      const allowedSettings = ['laziness', 'coherence', 'sassiness', 'markov_order', 'silence_minutes'];
      if (!allowedSettings.includes(setting)) {
        throw new Error(`Invalid setting: ${setting}`);
      }

      const stmt = this.db.prepare(`
        INSERT INTO personality_settings (chat_id, ${setting}, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET ${setting} = ?, updated_at = ?
      `);

      const timestamp = Date.now();
      stmt.run(chatId, value, timestamp, value, timestamp);
      return true;
    } catch (error) {
      logger.error(`Error updating personality setting: ${error.message}`);
      return false;
    }
  }

  close() {
    this.db.close();
  }
}

// Singleton instance
module.exports = new MarkovDatabaseService();
