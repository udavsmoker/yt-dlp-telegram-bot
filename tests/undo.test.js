const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const undoService = require('../src/services/undo.service');
const handleUndo = require('../src/handlers/undo.handler');

describe('UndoService & handleUndo', () => {
  beforeEach(() => {
    undoService.clear();
  });

  describe('UndoService', () => {
    it('should record single and array of message IDs', () => {
      undoService.record(100, 101, 555);
      undoService.record(100, [102, 103], 555);

      const entry = undoService.findAndRemove(100, null, 555, false);
      assert.deepEqual(entry.messageIds, [102, 103]);

      const previousEntry = undoService.findAndRemove(100, null, 555, false);
      assert.deepEqual(previousEntry.messageIds, [101]);
    });

    it('should find entry by specific messageId', () => {
      undoService.record(100, [101, 102], 555);
      undoService.record(100, [103, 104], 777);

      const found = undoService.findAndRemove(100, 102, 555, false);
      assert.ok(found);
      assert.deepEqual(found.messageIds, [101, 102]);

      // Ensure it was removed
      const searchAgain = undoService.findAndRemove(100, 102, 555, false);
      assert.equal(searchAgain, null);
    });

    it('should prevent non-admin from undoing another user media', () => {
      undoService.record(100, [101], 555);

      const result = undoService.findAndRemove(100, 101, 999, false);
      assert.ok(result);
      assert.equal(result.unauthorized, true);
    });

    it('should allow chat admin to undo any user media', () => {
      undoService.record(100, [101], 555);

      const result = undoService.findAndRemove(100, 101, 999, true);
      assert.ok(result);
      assert.deepEqual(result.messageIds, [101]);
    });

    it('should prune entries exceeding maxEntries', () => {
      const customService = new undoService.UndoService(2, 60000);
      customService.record(100, [1], 555);
      customService.record(100, [2], 555);
      customService.record(100, [3], 555);

      // 1 should have been evicted
      assert.equal(customService.findAndRemove(100, 1, 555, false), null);
      // 3 should be latest
      assert.deepEqual(customService.findAndRemove(100, null, 555, false).messageIds, [3]);
      // 2 should be remaining
      assert.deepEqual(customService.findAndRemove(100, null, 555, false).messageIds, [2]);
    });

    it('should ignore expired entries', () => {
      const customService = new undoService.UndoService(10, 50); // 50ms TTL
      customService.record(100, [1], 555);

      // Fake timestamp into the past
      const list = customService.history.get('100');
      list[0].timestamp = Date.now() - 1000;

      const result = customService.findAndRemove(100, 1, 555, false);
      assert.equal(result, null);
    });
  });

  describe('handleUndo handler', () => {
    it('should delete recent media when called without reply', async () => {
      undoService.record(200, [501, 502], 123);

      const deletedMessages = [];
      const ctx = {
        chat: { id: 200, type: 'group' },
        from: { id: 123, first_name: 'Alice' },
        message: { message_id: 600, text: '/undo' },
        getChatMember: async () => ({ status: 'member' }),
        telegram: {
          deleteMessage: async (chatId, msgId) => {
            deletedMessages.push({ chatId, msgId });
          }
        },
        deleteMessage: async () => {
          deletedMessages.push({ chatId: 200, msgId: 600 });
        },
        reply: async () => ({ message_id: 601 })
      };

      await handleUndo(ctx);

      assert.ok(deletedMessages.some(d => d.msgId === 501));
      assert.ok(deletedMessages.some(d => d.msgId === 502));
      assert.ok(deletedMessages.some(d => d.msgId === 600)); // The /undo message itself
    });

    it('should reject non-bot replied message', async () => {
      let repliedText = '';
      const ctx = {
        chat: { id: 200, type: 'group' },
        from: { id: 123 },
        botInfo: { id: 999 },
        message: {
          message_id: 600,
          text: '/undo',
          reply_to_message: {
            message_id: 400,
            from: { id: 888 } // Not bot
          }
        },
        reply: async (text) => { repliedText = text; }
      };

      await handleUndo(ctx);
      assert.match(repliedText, /Reply to a message sent by the bot/);
    });

    it('should delete targeted replied message from bot', async () => {
      undoService.record(200, [400], 123);

      const deletedMessages = [];
      const ctx = {
        chat: { id: 200, type: 'group' },
        from: { id: 123, first_name: 'Alice' },
        botInfo: { id: 999 },
        message: {
          message_id: 600,
          text: '/undo',
          reply_to_message: {
            message_id: 400,
            from: { id: 999 } // Bot
          }
        },
        getChatMember: async () => ({ status: 'member' }),
        telegram: {
          deleteMessage: async (chatId, msgId) => {
            deletedMessages.push({ chatId, msgId });
          }
        },
        deleteMessage: async () => {},
        reply: async () => ({ message_id: 601 })
      };

      await handleUndo(ctx);
      assert.ok(deletedMessages.some(d => d.msgId === 400));
    });
  });
});
