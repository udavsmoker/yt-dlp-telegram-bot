const logger = require('../../../utils/logger');
const { cleanupFile } = require('../../../utils/helpers');

class BaseStrategy {
  constructor(name) {
    this.name = name;
  }

  /**
   * Determine if the strategy can process the given URL.
   * @param {string} url
   * @returns {boolean}
   */
  canHandle(url) {
    throw new Error(`Strategy "${this.name}" must implement canHandle()`);
  }

  /**
   * Execute download and sending logic for the platform.
   * @param {object} ctx - Telegraf context
   * @param {object} options - { url, statusMessage, userInfo, originalMessageId }
   */
  async handle(ctx, options) {
    throw new Error(`Strategy "${this.name}" must implement handle()`);
  }

  /**
   * Clean up a list of file paths.
   * @param {Array<string>} files
   */
  async cleanupFiles(files = []) {
    for (const f of files) {
      if (f) await cleanupFile(f).catch(() => {});
    }
  }

  /**
   * Sanitize error message and display helpful user-facing guidance.
   * @param {object} ctx
   * @param {number} statusMessageId
   * @param {Error} error
   * @param {string} userInfo
   * @param {boolean} isPhotoPost
   */
  async sendErrorMessage(ctx, statusMessageId, error, userInfo, isPhotoPost = false) {
    logger.error(`Download failed for ${userInfo} via ${this.name}: ${error.message}`);

    let safeErrorMsg = error.message ? error.message.replace(/[_*[\]`~>#+\-=|{}.!()\\]/g, ' ').trim() : 'Unknown error';
    if (safeErrorMsg.startsWith('YTDLP_ERROR:')) {
      safeErrorMsg = safeErrorMsg.replace('YTDLP_ERROR:', '').trim();
    }

    if (isPhotoPost && safeErrorMsg.includes('There is no video in this post')) {
      safeErrorMsg = 'Failed to download Instagram photo post. The photo service was temporarily unavailable, please try again in a few moments.';
    }

    const maxSize = ctx.telegram.options?.apiRoot?.includes('localhost') ? '2000' : '50';
    const errorText = `❌ ${safeErrorMsg}\n\n*Troubleshooting:*\n• Ensure link is valid\n• ${isPhotoPost ? 'Post' : 'Video'} must be public\n• Max size: ${maxSize}MB\n• Platform must be supported`;

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessageId,
        null,
        errorText,
        { parse_mode: 'Markdown' }
      );
    } catch {
      try {
        const plainText = errorText.replace(/[*_`]/g, '');
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessageId,
          null,
          plainText
        );
      } catch (finalErr) {
        logger.error(`Failed to send fallback error text to ${userInfo}: ${finalErr.message}`);
      }
    }
  }
}

module.exports = BaseStrategy;
