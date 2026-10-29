const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const inlineService = require('../src/services/inline.service');
const cacheService = require('../src/services/cache.service');
const { handleInlineQuery } = require('../src/handlers/inline.handler');

describe('Inline Mode Service & Handlers', () => {
  beforeEach(() => {
    inlineService.queryCache.clear();
  });

  describe('Help & Guide Results', () => {
    it('should return guide articles for empty or whitespace query', async () => {
      const resultsEmpty = await inlineService.handleQuery('', 'test_bot');
      assert.equal(resultsEmpty.length, 2);
      assert.equal(resultsEmpty[0].type, 'article');
      assert.equal(resultsEmpty[0].id, 'guide_video');
      assert.equal(resultsEmpty[1].id, 'guide_music');
      assert.ok(resultsEmpty[0].input_message_content.message_text.includes('@test_bot'));

      const resultsSpaces = await inlineService.handleQuery('    ', 'test_bot');
      assert.equal(resultsSpaces.length, 2);
    });
  });

  describe('URL Routing & Cache Lookup', () => {
    it('should return instant cached video result when URL is in SQLite cache', async () => {
      const testUrl = 'https://www.tiktok.com/@creator/video/1234567890';
      cacheService.set(testUrl, {
        fileId: 'BAADBAAD_TEST_VIDEO_FILE_ID',
        fileType: 'video',
        title: 'Hilarious Cat Video',
        author: 'CatCreator',
        platform: 'TikTok',
        duration: '15'
      });

      const results = await inlineService.handleQuery(testUrl, 'test_bot');
      assert.ok(results.length >= 1);
      assert.equal(results[0].type, 'video');
      assert.equal(results[0].video_file_id, 'BAADBAAD_TEST_VIDEO_FILE_ID');
      assert.equal(results[0].title, 'Hilarious Cat Video');
      assert.equal(results[0].caption, '👤 <b>@CatCreator</b>');
      assert.equal(results[0].reply_markup.inline_keyboard[0][0].text, '↗️');
    });

    it('should return instant cached audio result when music URL is in SQLite cache without duplicate caption', async () => {
      const testUrl = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
      cacheService.set(testUrl, {
        fileId: 'CQACAgIAAxkBAAI_AUDIO_FILE_ID',
        fileType: 'audio',
        title: 'Numb',
        author: 'Linkin Park',
        platform: 'Spotify',
        duration: '187'
      });

      const results = await inlineService.handleQuery(testUrl, 'test_bot');
      assert.ok(results.length >= 1);
      assert.equal(results[0].type, 'audio');
      assert.equal(results[0].audio_file_id, 'CQACAgIAAxkBAAI_AUDIO_FILE_ID');
      assert.equal(results[0].title, 'Numb');
      assert.equal(results[0].performer, 'Linkin Park');
      assert.equal(results[0].caption, undefined);
    });

    it('should provide download article with short token for uncached generic URL', async () => {
      const genericUrl = 'https://vimeo.com/987654321';
      const results = await inlineService.handleQuery(genericUrl, 'test_bot');
      assert.ok(results.length >= 1);
      assert.equal(results[0].type, 'article');
      assert.ok(results[0].title.includes('Download Media'));
      const token = results[0].id.replace('gen_', '');
      assert.ok(token.length <= 15);
      assert.equal(inlineService.getShortLink(token), genericUrl);
    });

    it('should resolve Instagram URL with auto-download article card', async () => {
      const instaUrl = 'https://www.instagram.com/reel/C8qV7X8I4Jz/';
      const results = await inlineService.handleQuery(instaUrl, 'test_bot');
      assert.ok(results.length >= 1);
      assert.equal(results[0].type, 'article');
      assert.ok(results[0].id.startsWith('ig_'));
      assert.ok(results[0].title.includes('Instagram'));
      const token = results[0].id.replace('ig_', '');
      assert.equal(inlineService.getShortLink(token), instaUrl);
    });

    it('should resolve Spotify track URL with 320 kbps MP3 article card', async () => {
      const spotifyUrl = 'https://open.spotify.com/intl-ru/track/3n3Ppam7vgaVa1iaRUc9Lp';
      const results = await inlineService.handleQuery(spotifyUrl, 'test_bot');
      assert.ok(results.length >= 1);
      assert.equal(results[0].type, 'article');
      assert.ok(results[0].id.startsWith('spot_'));
      assert.ok(results[0].title);
    });

    it('should offer bot PM quality selector for regular long YouTube videos', async () => {
      const ytUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const results = await inlineService.handleQuery(ytUrl, 'test_bot');
      assert.ok(results.length >= 2);
      const pmCard = results[0];
      assert.ok(pmCard.id.startsWith('yt_pm_'));
      assert.ok(pmCard.reply_markup.inline_keyboard[0][0].url.includes('t.me/test_bot?start='));
      const directCard = results[1];
      assert.ok(directCard.id.startsWith('yt_'));
      assert.ok(directCard.reply_markup.inline_keyboard[0][0].callback_data.startsWith('inline_dl:yt_'));
    });

    it('should offer direct in-chat download for YouTube Shorts', async () => {
      const shortsUrl = 'https://www.youtube.com/shorts/abcdef12345';
      const results = await inlineService.handleQuery(shortsUrl, 'test_bot');
      assert.ok(results.length >= 1);
      assert.equal(results[0].type, 'article');
      assert.ok(results[0].id.startsWith('yt_'));
      assert.ok(results[0].reply_markup.inline_keyboard[0][0].callback_data.startsWith('inline_dl:yt_'));
    });
  });

  describe('Short Link Management', () => {
    it('should create and retrieve short links for deep linking', () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&very_long_tracking_params=12345';
      const token = inlineService.createShortLink(url);
      assert.ok(token.startsWith('s_'));
      assert.ok(token.length < 20);
      assert.equal(inlineService.getShortLink(token), url);
      assert.equal(inlineService.getShortLink('non_existent'), null);
    });

    it('should store and retrieve pending track metadata', () => {
      const track = {
        id: 'yt_123',
        youtubeId: '123',
        title: 'Song Title',
        artist: 'Artist Name'
      };
      inlineService.setPendingTrack('song_123', track);
      assert.deepEqual(inlineService.getPendingTrack('song_123'), {
        ...track,
        expiresAt: inlineService.getPendingTrack('song_123').expiresAt
      });
    });
  });

  describe('Music Search Query Resolution', () => {
    it('should search tracks for text query and return candidate articles with auto-download markup', async () => {
      const query = 'Queen Bohemian Rhapsody';
      const results = await inlineService.handleQuery(query, 'test_bot');
      assert.ok(results.length > 0);
      const first = results[0];
      assert.ok(first.type === 'article' || first.type === 'audio');
      assert.ok(first.title);
      if (first.type === 'article') {
        assert.ok(/^inline_dl:(?:spot|song)_/.test(first.reply_markup.inline_keyboard[0][0].callback_data));
      }
    });

    it('should cache repeated queries in-memory', async () => {
      const query = 'Test Unique Song Query';
      const res1 = await inlineService.handleQuery(query, 'test_bot');
      const cacheKey = `test_bot:${query.toLowerCase()}`;
      assert.ok(inlineService.queryCache.has(cacheKey));

      const res2 = await inlineService.handleQuery(query, 'test_bot');
      assert.deepEqual(res1, res2);
    });
  });

  describe('Inline Handler Execution', () => {
    it('should answer inline query with results and cache_time', async () => {
      let answeredResults = null;
      let answeredOptions = null;

      const mockCtx = {
        inlineQuery: { query: '' },
        botInfo: { username: 'my_awesome_bot' },
        answerInlineQuery: async (results, opts) => {
          answeredResults = results;
          answeredOptions = opts;
        }
      };

      await handleInlineQuery(mockCtx);
      assert.ok(Array.isArray(answeredResults));
      assert.equal(answeredResults.length, 2);
      assert.equal(answeredOptions.cache_time, 60);
    });
  });
});
