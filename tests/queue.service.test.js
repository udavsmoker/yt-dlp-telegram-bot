const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { QueueService, ProgressReporter } = require('../src/services/queue.service');

describe('QueueService & ProgressReporter', () => {
  describe('QueueService', () => {
    it('should execute tasks concurrently up to concurrency limit', async () => {
      const queue = new QueueService();
      queue.concurrency = 2;

      let activeCount = 0;
      let maxSeenActive = 0;

      const createTask = (durationMs) => async () => {
        activeCount++;
        maxSeenActive = Math.max(maxSeenActive, activeCount);
        await new Promise(r => setTimeout(r, durationMs));
        activeCount--;
        return 'done';
      };

      const p1 = queue.enqueue(createTask(50));
      const p2 = queue.enqueue(createTask(50));
      const p3 = queue.enqueue(createTask(50));

      const stats = queue.getStats();
      assert.equal(stats.active, 2);
      assert.equal(stats.waiting, 1);

      const results = await Promise.all([p1, p2, p3]);
      assert.deepEqual(results, ['done', 'done', 'done']);
      assert.equal(maxSeenActive, 2);
      assert.equal(queue.getStats().active, 0);
      assert.equal(queue.getStats().waiting, 0);
    });

    it('should propagate task failure without breaking queue processing', async () => {
      const queue = new QueueService();
      queue.concurrency = 1;

      const failTask = async () => {
        throw new Error('Task Failed');
      };
      const okTask = async () => 'success';

      const p1 = queue.enqueue(failTask);
      const p2 = queue.enqueue(okTask);

      await assert.rejects(p1, { message: 'Task Failed' });
      const result2 = await p2;
      assert.equal(result2, 'success');
    });
  });

  describe('ProgressReporter', () => {
    it('should flush initial update immediately and throttle subsequent updates', async () => {
      const editedMessages = [];
      const mockCtx = {
        chat: { id: 123 },
        telegram: {
          editMessageText: async (_chatId, _msgId, _inline, text) => {
            editedMessages.push(text);
          }
        }
      };

      const reporter = new ProgressReporter(mockCtx, 999, 100);

      // First update - immediate
      reporter.update('Progress 10%');
      assert.equal(editedMessages.length, 1);
      assert.equal(editedMessages[0], 'Progress 10%');

      // Second update within throttle interval - should be queued
      reporter.update('Progress 20%');
      assert.equal(editedMessages.length, 1); // Not sent yet

      // Wait for throttle window
      await new Promise(r => setTimeout(r, 130));
      assert.equal(editedMessages.length, 2);
      assert.equal(editedMessages[1], 'Progress 20%');

      reporter.stop();
    });

    it('should stop timer cleanly without sending queued updates', async () => {
      const editedMessages = [];
      const mockCtx = {
        chat: { id: 123 },
        telegram: {
          editMessageText: async (_chatId, _msgId, _inline, text) => {
            editedMessages.push(text);
          }
        }
      };

      const reporter = new ProgressReporter(mockCtx, 999, 100);
      reporter.update('Init');
      assert.equal(editedMessages.length, 1);

      reporter.update('Update 2');
      reporter.stop();

      await new Promise(r => setTimeout(r, 150));
      // Should not have flushed Update 2 after stop()
      assert.equal(editedMessages.length, 1);
    });
  });
});
