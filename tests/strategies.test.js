const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const BaseStrategy = require('../src/handlers/download/strategies/base.strategy');
const YouTubeStrategy = require('../src/handlers/download/strategies/youtube.strategy');
const InstagramStrategy = require('../src/handlers/download/strategies/instagram.strategy');
const TikTokStrategy = require('../src/handlers/download/strategies/tiktok.strategy');
const BlueskyStrategy = require('../src/handlers/download/strategies/bluesky.strategy');
const GenericStrategy = require('../src/handlers/download/strategies/generic.strategy');
const { getSenderInfo, buildCaption, truncateTitle } = require('../src/handlers/download/common/telegram-sender');

describe('Download Strategies & Telegram Sender', () => {
  describe('Strategy routing (canHandle)', () => {
    const youtube = new YouTubeStrategy();
    const instagram = new InstagramStrategy();
    const tiktok = new TikTokStrategy();
    const bluesky = new BlueskyStrategy();
    const generic = new GenericStrategy();

    it('should correctly match YouTube URLs', () => {
      assert.equal(youtube.canHandle('https://youtube.com/watch?v=123'), true);
      assert.equal(youtube.canHandle('https://youtu.be/123'), true);
      assert.equal(youtube.canHandle('https://tiktok.com/@u/video/1'), false);
    });

    it('should correctly match Instagram URLs', () => {
      assert.equal(instagram.canHandle('https://instagram.com/p/C123/'), true);
      assert.equal(instagram.canHandle('https://instagram.com/reel/C123/'), true);
      assert.equal(instagram.canHandle('https://youtube.com/watch?v=1'), false);
    });

    it('should correctly match TikTok URLs', () => {
      assert.equal(tiktok.canHandle('https://www.tiktok.com/@user/video/123'), true);
      assert.equal(tiktok.canHandle('https://vm.tiktok.com/ZM8abc/'), true);
      assert.equal(tiktok.canHandle('https://bsky.app/profile/u/post/1'), false);
    });

    it('should correctly match Bluesky URLs', () => {
      assert.equal(bluesky.canHandle('https://bsky.app/profile/user.bsky.social/post/3k123'), true);
      assert.equal(bluesky.canHandle('https://twitter.com/user/status/1'), false);
    });

    it('should act as catch-all fallback for other supported platforms', () => {
      assert.equal(generic.canHandle('https://twitter.com/user/status/123'), true);
      assert.equal(generic.canHandle('https://reddit.com/r/videos/comments/123'), true);
      assert.equal(generic.canHandle('https://vimeo.com/12345'), true);
    });
  });

  describe('BaseStrategy error handling', () => {
    const base = new BaseStrategy('TestStrategy');

    it('should sanitize Markdown characters and send user-friendly message', async () => {
      let sentText = '';
      let parseMode = '';

      const mockCtx = {
        chat: { id: 100 },
        telegram: {
          options: { apiRoot: 'http://localhost:8081' },
          editMessageText: async (_chatId, _msgId, _inline, text, opts) => {
            sentText = text;
            parseMode = opts?.parse_mode;
          }
        }
      };

      const error = new Error('YTDLP_ERROR: Video [private] cannot be downloaded *test*');
      await base.sendErrorMessage(mockCtx, 555, error, '@user (123)');

      assert.ok(sentText.includes('❌'));
      assert.ok(!sentText.includes('YTDLP_ERROR:'));
      assert.ok(sentText.includes('Max size: 2000MB'));
      assert.equal(parseMode, 'Markdown');
    });
  });

  describe('Telegram Sender formatting', () => {
    it('should extract sender name and HTML mention for user', () => {
      const mockCtx = {
        from: { id: 111, first_name: 'Alice', last_name: 'Smith' },
        chat: { type: 'group' }
      };
      const info = getSenderInfo(mockCtx);
      assert.equal(info.name, 'Alice Smith');
      assert.equal(info.caption, '<a href="tg://user?id=111">Alice Smith</a>');
    });

    it('should extract channel title for channel posts', () => {
      const mockCtx = {
        from: null,
        chat: { type: 'channel', title: 'News Channel' }
      };
      const info = getSenderInfo(mockCtx);
      assert.equal(info.name, 'News Channel');
      assert.equal(info.caption, 'News Channel');
    });

    it('should truncate titles longer than max length with ellipsis', () => {
      const longTitle = 'A'.repeat(120);
      const truncated = truncateTitle(longTitle, 50);
      assert.equal(truncated.length, 51);
      assert.ok(truncated.endsWith('…'));
    });

    it('should construct caption with metadata and author', () => {
      const sender = { caption: 'John' };
      const url = 'https://youtube.com/watch?v=123';
      const info = {
        title: 'Amazing Nature 4K',
        author: 'NatGeo',
        duration: '1:30'
      };

      const caption = buildCaption(sender, url, info);
      assert.ok(caption.includes('Amazing Nature 4K'));
      assert.ok(caption.includes('John'));
      assert.ok(caption.includes('NatGeo'));
      assert.ok(caption.includes('1:30'));
    });
  });
});
