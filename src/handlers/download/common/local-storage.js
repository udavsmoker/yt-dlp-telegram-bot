const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const config = require('../../../config');
const logger = require('../../../utils/logger');
const { generateFilename, ensureDir } = require('../../../utils/helpers');

/**
 * Check if the bot is configured to use a local Telegram Bot API server.
 * @returns {boolean}
 */
function isLocalBotApi() {
  return Boolean(config.botApiUrl && (config.botApiUrl.includes('localhost') || config.botApiUrl.includes('127.0.0.1')));
}

/**
 * Resolve local disk path for any Telegram file_id (audio, video, photo, voice).
 * For local Bot API servers, returns the direct filesystem path without downloading.
 * For public Bot API servers, downloads the file to the temp directory.
 * @param {object} ctx - Telegraf context
 * @param {string} fileId - Telegram file_id
 * @param {string} [defaultExt='bin']
 * @returns {Promise<{ localPath: string, needsCleanup: boolean }>}
 */
async function getTelegramFileLocalPath(ctx, fileId, defaultExt = 'bin') {
  if (isLocalBotApi()) {
    const file = await ctx.telegram.getFile(fileId);
    if (file.file_path && file.file_path.startsWith('/')) {
      logger.info(`Local Bot API file path: ${file.file_path}`);
      return { localPath: file.file_path, needsCleanup: false };
    }
  }

  const fileLink = await ctx.telegram.getFileLink(fileId);
  await ensureDir(config.download.tempDir);
  const tempPath = path.join(config.download.tempDir, generateFilename('tg_file', defaultExt));

  const response = await axios({
    method: 'GET',
    url: fileLink.toString(),
    responseType: 'arraybuffer',
    timeout: 120000
  });
  await fs.writeFile(tempPath, response.data);

  return { localPath: tempPath, needsCleanup: true };
}

/**
 * Resolve local disk path for a Telegram file_id.
 * Backwards compatible alias for getVideoLocalPath.
 * @param {object} ctx - Telegraf context
 * @param {string} fileId - Telegram file_id
 * @returns {Promise<{ localPath: string, needsCleanup: boolean }>}
 */
async function getVideoLocalPath(ctx, fileId) {
  return getTelegramFileLocalPath(ctx, fileId, 'mp4');
}

module.exports = {
  isLocalBotApi,
  getVideoLocalPath,
  getTelegramFileLocalPath
};
