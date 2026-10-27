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
    this.currentEditPromise = null;
    this.stopped = false;
  }

  update(text) {
    if (this.stopped || !text || text === this.lastText) return;
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
    if (this.stopped || this.isEditing) return;
    if (!this.pendingText || this.pendingText === this.lastText) return;

    const textToSend = this.pendingText;
    this.lastText = textToSend;
    this.lastUpdate = Date.now();
    this.isEditing = true;

    try {
      this.currentEditPromise = this.ctx.telegram.editMessageText(
        this.ctx.chat.id,
        this.statusMessageId,
        null,
        textToSend
      );
      await this.currentEditPromise;
    } catch {
      // Suppress rate limits or duplicate edit errors
    } finally {
      this.currentEditPromise = null;
      this.isEditing = false;
      if (!this.stopped && this.pendingText && this.pendingText !== this.lastText && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, this.intervalMs);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.pendingText = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Safely stop reporting and update message to cancelled text,
   * waiting for any in-flight edit to complete first so it never overwrites the cancel text.
   * @param {string} cancelledText
   */
  async cancel(cancelledText = '❌ Download cancelled.') {
    this.stop();
    if (this.currentEditPromise) {
      try {
        await this.currentEditPromise;
      } catch {}
    }
    try {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat.id,
        this.statusMessageId,
        null,
        cancelledText
      );
      this.lastText = cancelledText;
    } catch {}
  }
}

class QueueService {
  constructor() {
    this.concurrency = config.queue?.concurrency || 2;
    this.running = new Map();
    this.waiting = [];
    this.nextJobId = 1;
  }

  /**
   * Enqueues an async download task, managing concurrency and queue status messages.
   * @param {Function} taskFn - async ({ signal }) => result
   * @param {object} meta - { ctx, statusMessageId, originalMessageId }
   * @returns {Promise<any>}
   */
  enqueue(taskFn, meta = {}) {
    return new Promise((resolve, reject) => {
      const abortController = new AbortController();
      const job = {
        id: this.nextJobId++,
        taskFn,
        ctx: meta.ctx,
        statusMessageId: meta.statusMessageId,
        originalMessageId: meta.originalMessageId,
        chatId: meta.ctx?.chat?.id,
        userId: meta.ctx?.from?.id,
        isPlaylistTrack: Boolean(meta.isPlaylistTrack),
        abortController,
        signal: abortController.signal,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        isCancelled: false
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
    if (job.isCancelled) {
      job.reject(new Error('DOWNLOAD_CANCELLED'));
      return;
    }

    this.running.set(job.id, job);
    logger.info(`Starting download job #${job.id} (active: ${this.running.size}/${this.concurrency}, queued: ${this.waiting.length})`);

    try {
      const result = await job.taskFn({ signal: job.signal });
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
    if (!job.ctx || !job.statusMessageId || job.isPlaylistTrack) return;
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
      if (!job.ctx || !job.statusMessageId || job.isPlaylistTrack) continue;
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

  /**
   * Cancel an in-flight or queued download job for a chat/user.
   * @param {string|number} chatId
   * @param {number|null} targetStatusMessageId
   * @param {number|null} userId
   * @param {boolean} isChatAdmin
   * @returns {{ job: object, stage: 'waiting'|'running' } | { unauthorized: true } | null}
   */
  cancelJob(chatId, targetStatusMessageId = null, userId = null, isChatAdmin = false) {
    const parsedTargetId = targetStatusMessageId ? Number(targetStatusMessageId) : null;
    const parsedUserId = userId ? Number(userId) : null;
    const keyChatId = Number(chatId);

    // 1. Check waiting queue first (newest to oldest or matching target)
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const job = this.waiting[i];
      if (Number(job.chatId) !== keyChatId) continue;
      if (parsedTargetId && job.statusMessageId !== parsedTargetId) continue;

      const isOwner = parsedUserId && job.userId === parsedUserId;
      if (!isChatAdmin && !isOwner && job.userId) {
        return { unauthorized: true };
      }

      this.waiting.splice(i, 1);
      job.isCancelled = true;
      job.abortController.abort();
      job.reject(new Error('DOWNLOAD_CANCELLED'));
      this.updateRemainingPositions();
      return { job, stage: 'waiting' };
    }

    // 2. Check running jobs
    for (const job of Array.from(this.running.values()).reverse()) {
      if (Number(job.chatId) !== keyChatId) continue;
      if (parsedTargetId && job.statusMessageId !== parsedTargetId) continue;

      const isOwner = parsedUserId && job.userId === parsedUserId;
      if (!isChatAdmin && !isOwner && job.userId) {
        return { unauthorized: true };
      }

      job.isCancelled = true;
      if (job.progressReporter) {
        job.progressReporter.stop();
      }
      job.abortController.abort();
      return { job, stage: 'running' };
    }

    return null;
  }

  createProgressReporter(ctx, statusMessageId) {
    const reporter = new ProgressReporter(ctx, statusMessageId);
    const parsedId = Number(statusMessageId);
    for (const job of this.running.values()) {
      if (job.statusMessageId === parsedId) {
        job.progressReporter = reporter;
        break;
      }
    }
    for (const job of this.waiting) {
      if (job.statusMessageId === parsedId) {
        job.progressReporter = reporter;
        break;
      }
    }
    return reporter;
  }

  getStats() {
    return {
      active: this.running.size,
      concurrency: this.concurrency,
      waiting: this.waiting.length
    };
  }
}

const instance = new QueueService();
instance.QueueService = QueueService;
instance.ProgressReporter = ProgressReporter;
module.exports = instance;
