const queueService = require('../services/queue.service');
const cacheService = require('../services/cache.service');
const config = require('../config');
const { formatFileSize, getUserInfo } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Format uptime seconds into human-readable string (e.g. "2d 4h 15m 30s").
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatUptime(totalSeconds) {
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor((totalSeconds / 3600) % 24);
  const days = Math.floor(totalSeconds / 86400);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

/**
 * Handle /health and /ping commands with clean system diagnostics.
 * @param {object} ctx - Telegraf context
 */
async function handleHealth(ctx) {
  const userInfo = getUserInfo(ctx);
  logger.info(`Health check requested by ${userInfo}`);

  const uptimeStr = formatUptime(process.uptime());

  // Memory
  const mem = process.memoryUsage();
  const rssStr = formatFileSize(mem.rss);
  const heapStr = formatFileSize(mem.heapUsed);

  // Queue
  const queueStats = queueService.getStats();
  const queueWaitingStr = queueStats.waiting > 0 ? ` (${queueStats.waiting} waiting)` : '';

  // Cache
  const cacheStats = cacheService.getStats();
  const cacheStr = cacheStats.enabled
    ? `${cacheStats.active || 0} active (${cacheStats.hits || 0} hits)`
    : 'Disabled';

  // Bot API
  const isLocalApi = Boolean(config.botApiUrl && (config.botApiUrl.includes('localhost') || config.botApiUrl.includes('127.0.0.1')));
  const apiStr = isLocalApi
    ? `Local server (${config.download.maxFileSizeMB}MB limit)`
    : `Official API (${config.download.maxFileSizeMB}MB limit)`;

  // Latency calculation from message timestamp
  const now = Date.now();
  const msgDateMs = ctx.message?.date ? ctx.message.date * 1000 : now;
  const latency = Math.max(0, now - msgDateMs);

  const text = [
    '<b>System Health</b>',
    '',
    '• <b>Status:</b> Operational',
    `• <b>Uptime:</b> ${uptimeStr}`,
    `• <b>Queue:</b> ${queueStats.active}/${queueStats.concurrency} active${queueWaitingStr}`,
    `• <b>Memory:</b> ${rssStr} (RSS) / ${heapStr} (Heap)`,
    `• <b>Cache:</b> ${cacheStr}`,
    `• <b>API:</b> ${apiStr}`,
    `• <b>Runtime:</b> Node.js ${process.version} (${process.platform})`,
    `• <b>Latency:</b> ${latency}ms`
  ].join('\n');

  await ctx.reply(text, { parse_mode: 'HTML' });
}

module.exports = {
  handleHealth,
  formatUptime
};
