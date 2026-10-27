const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const queueService = require('../src/services/queue.service');
const handleCancel = require('../src/handlers/cancel.handler');
const { youtubeStrategy } = require('../src/handlers/download');

describe('Cancel Handler & Download Cancellation', () => {
  describe('QueueService.cancelJob', () => {
    it('should cancel waiting job and reject promise with DOWNLOAD_CANCELLED', async () => {
      const queue = new queueService.QueueService();
      queue.concurrency = 1;

      // Fill running slot
      let finishFirst;
      const runningPromise = queue.enqueue(() => new Promise(res => { finishFirst = res; }), {
        ctx: { chat: { id: 100 }, from: { id: 1 } },
        statusMessageId: 10
      });

      // Add waiting job
      const waitingPromise = queue.enqueue(() => Promise.resolve('should not run'), {
        ctx: { chat: { id: 100 }, from: { id: 2 } },
        statusMessageId: 20
      });

      assert.equal(queue.getStats().waiting, 1);

      // Cancel waiting job
      const cancelResult = queue.cancelJob(100, 20, 2, false);
      assert.ok(cancelResult);
      assert.equal(cancelResult.stage, 'waiting');
      assert.equal(queue.getStats().waiting, 0);

      await assert.rejects(waitingPromise, { message: 'DOWNLOAD_CANCELLED' });

      finishFirst('done');
      await runningPromise;
    });

    it('should abort running job via abortController signal', async () => {
      const queue = new queueService.QueueService();
      queue.concurrency = 1;

      let receivedSignal = null;
      let abortFired = false;

      const runningTask = ({ signal }) => {
        receivedSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortFired = true;
            reject(new Error('DOWNLOAD_CANCELLED'));
          });
        });
      };

      const p = queue.enqueue(runningTask, {
        ctx: { chat: { id: 100 }, from: { id: 5 } },
        statusMessageId: 50
      });

      assert.equal(queue.getStats().active, 1);

      const cancelResult = queue.cancelJob(100, 50, 5, false);
      assert.ok(cancelResult);
      assert.equal(cancelResult.stage, 'running');
      assert.ok(abortFired);
      assert.ok(receivedSignal?.aborted);

      await assert.rejects(p, { message: 'DOWNLOAD_CANCELLED' });
      assert.equal(queue.getStats().active, 0);
    });

    it('should prevent unauthorized cancellation for non-admin', () => {
      const queue = new queueService.QueueService();
      queue.concurrency = 1;

      queue.enqueue(() => new Promise(() => {}), {
        ctx: { chat: { id: 100 }, from: { id: 10 } },
        statusMessageId: 100
      });

      // Different user (id 99) tries to cancel user 10's job
      const result = queue.cancelJob(100, 100, 99, false);
      assert.ok(result);
      assert.equal(result.unauthorized, true);
    });

    it('should allow chat admin to cancel another user download', () => {
      const queue = new queueService.QueueService();
      queue.concurrency = 1;

      queue.enqueue(() => new Promise(() => {}), {
        ctx: { chat: { id: 100 }, from: { id: 10 } },
        statusMessageId: 100
      });

      // Admin cancels
      const result = queue.cancelJob(100, 100, 99, true);
      assert.ok(result);
      assert.equal(result.stage, 'running');
    });
  });

  describe('handleCancel command', () => {
    it('should cancel active download and reply with confirmation', async () => {
      let cancelledTask = false;
      const mockTask = ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          cancelledTask = true;
          reject(new Error('DOWNLOAD_CANCELLED'));
        });
      });

      const enqueuePromise = queueService.enqueue(mockTask, {
        ctx: { chat: { id: 300 }, from: { id: 77 } },
        statusMessageId: 301
      });

      let replyText = '';
      const deletedMessages = [];
      const editedMessages = [];

      const ctx = {
        chat: { id: 300, type: 'group' },
        from: { id: 77, first_name: 'Bob' },
        message: { message_id: 302, text: '/cancel' },
        getChatMember: async () => ({ status: 'member' }),
        telegram: {
          editMessageText: async (_chatId, msgId, _inline, text) => {
            editedMessages.push({ msgId, text });
          },
          deleteMessage: async (chatId, msgId) => {
            deletedMessages.push({ chatId, msgId });
          }
        },
        deleteMessage: async () => {
          deletedMessages.push({ chatId: 300, msgId: 302 });
        },
        reply: async (text) => {
          replyText = text;
          return { message_id: 303 };
        }
      };

      await handleCancel(ctx);

      assert.ok(cancelledTask);
      // Status message was edited in-place, no duplicate reply sent
      assert.equal(replyText, '');
      assert.ok(editedMessages.some(e => e.msgId === 301 && e.text.includes('cancelled')));
      await assert.rejects(enqueuePromise, { message: 'DOWNLOAD_CANCELLED' });
    });

    it('should cancel pending YouTube selection keyboard', async () => {
      youtubeStrategy.pendingYouTubeDownloads.set(990, {
        userId: 88,
        url: 'https://youtube.com/watch?v=123',
        originalMessageId: 989,
        chatId: 400
      });

      let replyText = '';
      const deletedMessages = [];
      const ctx = {
        chat: { id: 400, type: 'private' },
        from: { id: 88 },
        message: { message_id: 991, text: '/cancel' },
        telegram: {
          deleteMessage: async (chatId, msgId) => {
            deletedMessages.push({ chatId, msgId });
          }
        },
        deleteMessage: async () => {},
        reply: async (text) => {
          replyText = text;
          return { message_id: 992 };
        }
      };

      await handleCancel(ctx);

      assert.match(replyText, /Request cancelled/);
      assert.ok(deletedMessages.some(d => d.msgId === 990));
      assert.equal(youtubeStrategy.pendingYouTubeDownloads.has(990), false);
    });

    it('should reply with notice when no active downloads exist', async () => {
      let replyText = '';
      const ctx = {
        chat: { id: 500, type: 'private' },
        from: { id: 99 },
        message: { message_id: 501, text: '/cancel' },
        reply: async (text) => { replyText = text; }
      };

      await handleCancel(ctx);
      assert.match(replyText, /No active downloads to cancel/);
    });
  });
});
