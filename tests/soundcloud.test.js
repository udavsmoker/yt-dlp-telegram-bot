const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const soundcloudService = require('../src/services/soundcloud.service');
const SoundCloudStrategy = require('../src/handlers/download/strategies/soundcloud.strategy');
const { isValidVideoUrl } = require('../src/utils/helpers');

describe('SoundCloud Service & Strategy', () => {
  describe('SoundCloud URL validation & parsing', () => {
    it('should correctly identify SoundCloud URLs with isSoundCloudUrl', () => {
      assert.equal(soundcloudService.isSoundCloudUrl('https://soundcloud.com/artist/track-name'), true);
      assert.equal(soundcloudService.isSoundCloudUrl('https://m.soundcloud.com/artist/track-name'), true);
      assert.equal(soundcloudService.isSoundCloudUrl('https://soundcloud.com/artist/sets/album-name'), true);
      assert.equal(soundcloudService.isSoundCloudUrl('https://on.soundcloud.com/abcde'), true);
      assert.equal(soundcloudService.isSoundCloudUrl('https://soundcloud.com/artist/track-name?in=artist/sets/album'), true);

      // Non-SoundCloud URLs
      assert.equal(soundcloudService.isSoundCloudUrl('https://youtube.com/watch?v=123'), false);
      assert.equal(soundcloudService.isSoundCloudUrl('https://open.spotify.com/track/123'), false);
      assert.equal(soundcloudService.isSoundCloudUrl(''), false);
      assert.equal(soundcloudService.isSoundCloudUrl(null), false);

      // Reserved pages
      assert.equal(soundcloudService.isSoundCloudUrl('https://soundcloud.com/discover'), false);
      assert.equal(soundcloudService.isSoundCloudUrl('https://soundcloud.com/upload'), false);
      assert.equal(soundcloudService.isSoundCloudUrl('https://soundcloud.com/terms-of-use'), false);
    });

    it('should be recognized by isValidVideoUrl in helpers', () => {
      assert.equal(isValidVideoUrl('https://soundcloud.com/artist/track-name'), true);
      assert.equal(isValidVideoUrl('https://m.soundcloud.com/artist/sets/album-name'), true);
      assert.equal(isValidVideoUrl('https://on.soundcloud.com/abcde'), true);
    });

    it('should accurately parse URL types and slugs with parseUrl', () => {
      const track = soundcloudService.parseUrl('https://soundcloud.com/kazuto-niggato/talking-body-if-you-love-me');
      assert.deepEqual(track, {
        type: 'track',
        artist: 'kazuto-niggato',
        slug: 'talking-body-if-you-love-me',
        url: 'https://soundcloud.com/kazuto-niggato/talking-body-if-you-love-me'
      });

      const set = soundcloudService.parseUrl('https://soundcloud.com/kicktracks/sets/chill-boom-bap-lo-fi-hip-hop');
      assert.deepEqual(set, {
        type: 'set',
        artist: 'kicktracks',
        slug: 'chill-boom-bap-lo-fi-hip-hop',
        url: 'https://soundcloud.com/kicktracks/sets/chill-boom-bap-lo-fi-hip-hop'
      });

      const shortlink = soundcloudService.parseUrl('https://on.soundcloud.com/abc123');
      assert.deepEqual(shortlink, {
        type: 'shortlink',
        url: 'https://on.soundcloud.com/abc123'
      });

      assert.equal(soundcloudService.parseUrl('https://youtube.com/watch?v=123'), null);
      assert.equal(soundcloudService.parseUrl('invalid'), null);
    });
  });

  describe('SoundCloudStrategy lifecycle & prompts', () => {
    it('should route SoundCloud URLs via canHandle', () => {
      const strategy = new SoundCloudStrategy();
      assert.equal(strategy.canHandle('https://soundcloud.com/artist/track'), true);
      assert.equal(strategy.canHandle('https://soundcloud.com/artist/sets/album'), true);
      assert.equal(strategy.canHandle('https://on.soundcloud.com/xyz'), true);
      assert.equal(strategy.canHandle('https://youtube.com/watch?v=123'), false);
      assert.equal(strategy.canHandle('https://open.spotify.com/track/123'), false);
    });

    it('should manage pending prompts and cancellation permissions with cancelPending', () => {
      const strategy = new SoundCloudStrategy();
      const promptMessageId = 555;
      const ownerId = 12345;
      const otherUserId = 67890;
      const chatId = -1001;

      strategy.pendingSoundCloudPrompts.set(promptMessageId, {
        userId: ownerId,
        chatId,
        url: 'https://soundcloud.com/artist/sets/test',
        entity: { title: 'Test Set', tracks: [] }
      });

      // Non-owner cannot cancel
      const unauthorizedResult = strategy.cancelPending(chatId, promptMessageId, otherUserId, false);
      assert.deepEqual(unauthorizedResult, { unauthorized: true });
      assert.equal(strategy.pendingSoundCloudPrompts.has(promptMessageId), true);

      // Owner can cancel
      const ownerResult = strategy.cancelPending(chatId, promptMessageId, ownerId, false);
      assert.equal(ownerResult.messageId, promptMessageId);
      assert.equal(strategy.pendingSoundCloudPrompts.has(promptMessageId), false);
    });

    it('should allow chat admins to cancel any pending prompt', () => {
      const strategy = new SoundCloudStrategy();
      const promptMessageId = 777;
      const ownerId = 12345;
      const adminId = 99999;
      const chatId = -1002;

      strategy.pendingSoundCloudPrompts.set(promptMessageId, {
        userId: ownerId,
        chatId,
        url: 'https://soundcloud.com/artist/sets/test',
        entity: { title: 'Test Set', tracks: [] }
      });

      const adminResult = strategy.cancelPending(chatId, promptMessageId, adminId, true);
      assert.equal(adminResult.messageId, promptMessageId);
      assert.equal(strategy.pendingSoundCloudPrompts.has(promptMessageId), false);
    });

    it('should manage active set cancellation via cancelActive', () => {
      const strategy = new SoundCloudStrategy();
      const statusMessageId = 444;
      const ownerId = 11111;
      const otherUserId = 22222;
      const adminId = 33333;
      const chatId = -1003;

      let aborted = false;
      const mockAbortController = {
        abort: () => { aborted = true; }
      };

      strategy.activePlaylists.set(statusMessageId, {
        abortController: mockAbortController,
        chatId,
        userId: ownerId,
        statusMessageId,
        title: 'Active Set',
        total: 10,
        getCompletedCount: () => 3
      });

      // Non-owner cannot cancel active set
      const unauth = strategy.cancelActive(chatId, statusMessageId, otherUserId, false);
      assert.deepEqual(unauth, { unauthorized: true });
      assert.equal(aborted, false);

      // Admin can cancel active set
      const adminCancel = strategy.cancelActive(chatId, statusMessageId, adminId, true);
      assert.equal(adminCancel.statusMessageId, statusMessageId);
      assert.equal(aborted, true);
      assert.equal(strategy.activePlaylists.has(statusMessageId), false);
    });

    it('should handle sc_cancel callback by deleting prompt', async () => {
      const strategy = new SoundCloudStrategy();
      const messageId = 888;
      const ownerId = 12345;

      strategy.pendingSoundCloudPrompts.set(messageId, {
        userId: ownerId,
        chatId: 100,
        url: 'https://soundcloud.com/test/sets/album',
        entity: { title: 'Album', tracks: [] }
      });

      let answered = false;
      let editedText = '';
      const mockCtx = {
        callbackQuery: { data: 'sc_cancel', message: { message_id: messageId } },
        from: { id: ownerId },
        chat: { id: 100 },
        answerCbQuery: async (msg) => { answered = true; },
        telegram: {
          editMessageText: async (chatId, msgId, text, content, opts) => {
            editedText = content;
          },
          deleteMessage: async () => {}
        }
      };

      await strategy.handleCallback(mockCtx);
      assert.equal(answered, true);
      assert.equal(strategy.pendingSoundCloudPrompts.has(messageId), false);
      assert.match(editedText, /Download cancelled/i);
    });
  });
});

