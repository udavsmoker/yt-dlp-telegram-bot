const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class BlacklistService {
  constructor() {
    this.dataDir = path.join(__dirname, '../../data');
    this.blacklistPath = path.join(this.dataDir, 'blacklist.json');
    this.blacklist = this.loadBlacklist();
    
    // Offensive responses for blacklisted users
    this.responses = [
      "да пошел ты нахуй",
      "не, не сегодня",
      "саси",
      "пиздуй отсюда",
      "хуй тебе, а не команда",
      "говорят у гандонов команды не работают",
      "писька не доросла до этой команды",
      "пошел ты нахуй со своими запросами",
      "сам решу",
      "не, нихуя",
      "пися попа сися кака",
      "cant deal with u faggots anymore",
      "sybau twin",
      "403: пошел нахуй.",
      "я подумаю",
      "не заслужил",
      "тише чурка",
      "ебальничек",
      "тиш тиш"
    ];
  }

  loadBlacklist() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      if (fs.existsSync(this.blacklistPath)) {
        const data = fs.readFileSync(this.blacklistPath, 'utf-8');
        const parsed = JSON.parse(data);
        return parsed.userIds || [];
      }
      
      // Initialize with first blacklisted user
      return [1003584037];
    } catch (error) {
      logger.error('Failed to load blacklist:', error);
      return [1003584037];
    }
  }

  saveBlacklist() {
    try {
      const data = {
        userIds: this.blacklist,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.blacklistPath, JSON.stringify(data, null, 2));
      logger.info(`Blacklist saved with ${this.blacklist.length} users`);
    } catch (error) {
      logger.error('Failed to save blacklist:', error);
      throw error;
    }
  }

  isBlacklisted(userId) {
    return this.blacklist.includes(userId);
  }

  addUser(userId) {
    if (!this.isBlacklisted(userId)) {
      this.blacklist.push(userId);
      this.saveBlacklist();
      logger.info(`User ${userId} added to blacklist`);
      return true;
    }
    return false;
  }

  removeUser(userId) {
    const index = this.blacklist.indexOf(userId);
    if (index > -1) {
      this.blacklist.splice(index, 1);
      this.saveBlacklist();
      logger.info(`User ${userId} removed from blacklist`);
      return true;
    }
    return false;
  }

  getBlacklistedUsers() {
    return [...this.blacklist];
  }

  getRandomResponse() {
    const randomIndex = Math.floor(Math.random() * this.responses.length);
    return this.responses[randomIndex];
  }

  getBlacklistCount() {
    return this.blacklist.length;
  }
}

module.exports = new BlacklistService();
