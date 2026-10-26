const config = require('../config');
const logger = require('../utils/logger');

class ProgressReporter {
  constructor(ctx, statusMessageId, intervalMs = 2000) {
    this.ctx = ctx;
    this.statusMessageId = statusMessageId;
    this.intervalMs = intervalMs;
    this.lastUpdate = 0;
    this.lastText = '';
    this.timer = null;
    this.pendingText = null;
    this.isEditing = false;
  }

  update(text) {
    if (!text || text === this.lastText) return;
    this.pendingText = text;

    const now = Date.now();
    if (!this.isEditing && (now - this.lastUpdate >= this.intervalMs || this.lastUpdate === 0)) {
      this.flush();
    } else if (!this.timer) {
      const wait = Math.max(100, this.intervalMs - (now - this.lastUpdate));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  async flush() {
    if (this.isEditing) return;
    if (!this.pendingText || this.pendingText === this.lastText) return;

    const textToSend = this.pendingText;
    this.lastText = textToSend;
    this.lastUpdate = Date.now();
    this.isEditing = true;

    try {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat.id,
        this.statusMessageId,
        null,
        textToSend
      );
    } catch {
      // Suppress rate limits or duplicate edit errors
    } finally {
      this.isEditing = false;
      if (this.pendingText && this.pendingText !== this.lastText && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, this.intervalMs);
      }
    }
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

class QueueService {
  constructor() {
    this.concurrency = config.queue?.concurrency || 2;
    this.running = new Set();
    this.waiting = [];
    this.nextJobId = 1;
  }

  /**
   * Enqueues an async download task, managing concurrency and queue status messages.
   * @param {Function} taskFn - async () => result
   * @param {object} meta - { ctx, statusMessageId }
   * @returns {Promise<any>}
   */
  enqueue(taskFn, meta = {}) {
    return new Promise((resolve, reject) => {
      const job = {
        id: this.nextJobId++,
        taskFn,
        ctx: meta.ctx,
        statusMessageId: meta.statusMessageId,
        resolve,
        reject,
        enqueuedAt: Date.now()
      };

      if (this.running.size < this.concurrency) {
        this.runJob(job);
      } else {
        this.waiting.push(job);
        this.notifyWaiting(job);
      }
    });
  }

  async runJob(job) {
    this.running.add(job.id);
    logger.info(`Starting download job #${job.id} (active: ${this.running.size}/${this.concurrency}, queued: ${this.waiting.length})`);

    try {
      const result = await job.taskFn();
      job.resolve(result);
    } catch (error) {
      job.reject(error);
    } finally {
      this.running.delete(job.id);
      this.dispatchNext();
    }
  }

  dispatchNext() {
    if (this.waiting.length > 0 && this.running.size < this.concurrency) {
      const nextJob = this.waiting.shift();
      this.runJob(nextJob);
      this.updateRemainingPositions();
    }
  }

  async notifyWaiting(job) {
    if (!job.ctx || !job.statusMessageId) return;
    const position = this.waiting.findIndex(j => j.id === job.id) + 1;
    try {
      await job.ctx.telegram.editMessageText(
        job.ctx.chat.id,
        job.statusMessageId,
        null,
        `⏳ In download queue (position #${position})...\nActive downloads: ${this.running.size}/${this.concurrency}`
      );
    } catch {
      // Suppress transient Telegram edit errors
    }
  }

  async updateRemainingPositions() {
    for (let i = 0; i < this.waiting.length; i++) {
      const job = this.waiting[i];
      if (!job.ctx || !job.statusMessageId) continue;
      const position = i + 1;
      try {
        await job.ctx.telegram.editMessageText(
          job.ctx.chat.id,
          job.statusMessageId,
          null,
          `⏳ In download queue (position #${position})...\nActive downloads: ${this.running.size}/${this.concurrency}`
        );
      } catch {}
    }
  }

  createProgressReporter(ctx, statusMessageId) {
    return new ProgressReporter(ctx, statusMessageId);
  }

  getStats() {
    return {
      active: this.running.size,
      concurrency: this.concurrency,
      waiting: this.waiting.length
    };
  }
}

module.exports = new QueueService();
