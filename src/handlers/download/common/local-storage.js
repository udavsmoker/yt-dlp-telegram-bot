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
 * Resolve local disk path for a Telegram file_id.
 * For local Bot API servers, returns the direct filesystem path without downloading.
 * For public Bot API servers, downloads the file to the temp directory.
 * @param {object} ctx - Telegraf context
 * @param {string} fileId - Telegram file_id
 * @returns {Promise<{ localPath: string, needsCleanup: boolean }>}
 */
async function getVideoLocalPath(ctx, fileId) {
  if (isLocalBotApi()) {
    const file = await ctx.telegram.getFile(fileId);
    const localPath = file.file_path;
    logger.info(`Local Bot API file path: ${localPath}`);
    return { localPath, needsCleanup: false };
  } else {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    await ensureDir(config.download.tempDir);
    const videoPath = path.join(config.download.tempDir, generateFilename('audio_source', 'mp4'));

    const response = await axios({
      method: 'GET',
      url: fileLink.toString(),
      responseType: 'arraybuffer',
      timeout: 120000
    });
    await fs.writeFile(videoPath, response.data);

    return { localPath: videoPath, needsCleanup: true };
  }
}

module.exports = {
  isLocalBotApi,
  getVideoLocalPath
};
