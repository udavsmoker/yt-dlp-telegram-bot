const logger = require('../utils/logger');

class UndoService {
  /**
   * @param {number} maxEntriesPerChat - Max records per chat (default 30)
   * @param {number} maxAgeMs - Max age in milliseconds (default 24 hours)
   */
  constructor(maxEntriesPerChat = 30, maxAgeMs = 24 * 60 * 60 * 1000) {
    this.maxEntries = maxEntriesPerChat;
    this.maxAgeMs = maxAgeMs;
    // Map<string, Array<{ messageIds: number[], userId: number|null, timestamp: number }>>
    this.history = new Map();
  }

  /**
   * Record sent media messages for potential undo/deletion.
   * @param {string|number} chatId
   * @param {number|number[]} messageIds
   * @param {number|null} userId
   */
  record(chatId, messageIds, userId = null) {
    if (!chatId || !messageIds) return;
    const ids = (Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(id => typeof id === 'object' && id?.message_id ? id.message_id : Number(id))
      .filter(id => !isNaN(id) && id > 0);

    if (ids.length === 0) return;

    const key = String(chatId);
    if (!this.history.has(key)) {
      this.history.set(key, []);
    }

    const list = this.history.get(key);
    list.push({
      messageIds: ids,
      userId: userId ? Number(userId) : null,
      timestamp: Date.now()
    });

    if (list.length > this.maxEntries) {
      list.shift();
    }
  }

  /**
   * Find and remove a media entry to undo.
   * If targetMessageId is provided, matches the entry containing that message ID.
   * If not provided, retrieves the latest entry for the user (or latest entry in chat if isChatAdmin).
   * 
   * @param {string|number} chatId
   * @param {number|null} targetMessageId
   * @param {number|null} userId
   * @param {boolean} isChatAdmin
   * @returns {{ messageIds: number[], userId: number|null } | { unauthorized: true } | null}
   */
  findAndRemove(chatId, targetMessageId = null, userId = null, isChatAdmin = false) {
    const key = String(chatId);
    const list = this.history.get(key);
    if (!list || list.length === 0) return null;

    const now = Date.now();
    // Prune expired entries
    const fresh = list.filter(e => now - e.timestamp <= this.maxAgeMs);
    this.history.set(key, fresh);
    if (fresh.length === 0) return null;

    const parsedTargetId = targetMessageId ? Number(targetMessageId) : null;
    const parsedUserId = userId ? Number(userId) : null;

    if (parsedTargetId) {
      const index = fresh.findIndex(e => e.messageIds.includes(parsedTargetId));
      if (index !== -1) {
        const entry = fresh[index];
        const isOwner = parsedUserId && entry.userId === parsedUserId;
        const isAnonymousOrUnowned = !entry.userId;

        if (isChatAdmin || isOwner || isAnonymousOrUnowned) {
          fresh.splice(index, 1);
          return entry;
        }
        return { unauthorized: true };
      }
      return null;
    }

    // No target message: search backwards for the user's latest entry, or the chat's latest if admin
    for (let i = fresh.length - 1; i >= 0; i--) {
      const entry = fresh[i];
      const isOwner = parsedUserId && entry.userId === parsedUserId;
      const isAnonymousOrUnowned = !entry.userId;

      if (isChatAdmin || isOwner || isAnonymousOrUnowned) {
        fresh.splice(i, 1);
        return entry;
      }
    }

    return null;
  }

  /**
   * Clear all records (useful for testing).
   */
  clear() {
    this.history.clear();
  }
}

const instance = new UndoService();
instance.UndoService = UndoService;
module.exports = instance;
