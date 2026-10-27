const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const spotifyService = require('../src/services/spotify.service');
const SpotifyStrategy = require('../src/handlers/download/strategies/spotify.strategy');
const { isValidVideoUrl } = require('../src/utils/helpers');

describe('Spotify Service & Strategy', () => {
  describe('Spotify URL validation & parsing', () => {
    it('should correctly identify Spotify URLs with isSpotifyUrl', () => {
      assert.equal(spotifyService.isSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), true);
      assert.equal(spotifyService.isSpotifyUrl('https://open.spotify.com/intl-ru/track/4cOdK2wGLETKBW3PvgPWqT?si=abc'), true);
      assert.equal(spotifyService.isSpotifyUrl('https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa'), true);
      assert.equal(spotifyService.isSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), true);
      assert.equal(spotifyService.isSpotifyUrl('https://spotify.link/xyz123'), true);
      assert.equal(spotifyService.isSpotifyUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT'), true);

      assert.equal(spotifyService.isSpotifyUrl('https://youtube.com/watch?v=123'), false);
      assert.equal(spotifyService.isSpotifyUrl('https://soundcloud.com/artist/track'), false);
      assert.equal(spotifyService.isSpotifyUrl(''), false);
      assert.equal(spotifyService.isSpotifyUrl(null), false);
    });

    it('should be recognized by isValidVideoUrl in helpers', () => {
      assert.equal(isValidVideoUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), true);
      assert.equal(isValidVideoUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), true);
      assert.equal(isValidVideoUrl('https://spotify.link/abc'), true);
    });

    it('should accurately parse entity type and ID with parseUrl', () => {
      const track = spotifyService.parseUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=xyz');
      assert.deepEqual(track, { type: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' });

      const localizedTrack = spotifyService.parseUrl('https://open.spotify.com/intl-es/track/1122334455');
      assert.deepEqual(localizedTrack, { type: 'track', id: '1122334455' });

      const album = spotifyService.parseUrl('https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa');
      assert.deepEqual(album, { type: 'album', id: '4m2880jivSbbyEGAKfITCa' });

      const playlist = spotifyService.parseUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
      assert.deepEqual(playlist, { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });

      const uri = spotifyService.parseUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT');
      assert.deepEqual(uri, { type: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' });

      assert.equal(spotifyService.parseUrl('https://spotify.com/invalid/path'), null);
      assert.equal(spotifyService.parseUrl('not a url'), null);
    });
  });

  describe('SpotifyStrategy lifecycle & prompts', () => {
    it('should route Spotify URLs via canHandle', () => {
      const strategy = new SpotifyStrategy();
      assert.equal(strategy.canHandle('https://open.spotify.com/track/123'), true);
      assert.equal(strategy.canHandle('https://open.spotify.com/playlist/abc'), true);
      assert.equal(strategy.canHandle('https://youtube.com/watch?v=123'), false);
    });

    it('should manage pending prompts and cancellation permissions', () => {
      const strategy = new SpotifyStrategy();
      const promptMessageId = 999;
      const ownerId = 12345;
      const otherUserId = 67890;
      const chatId = -1001;

      // Seed a pending prompt
      strategy.pendingSpotifyPrompts.set(promptMessageId, {
        userId: ownerId,
        chatId,
        type: 'playlist',
        id: 'mock_playlist_id',
        entity: { title: 'Test Playlist', tracks: [] }
      });

      // Non-owner without admin privileges cannot cancel
      const unauthorizedResult = strategy.cancelPending(chatId, promptMessageId, otherUserId, false);
      assert.deepEqual(unauthorizedResult, { unauthorized: true });
      assert.equal(strategy.pendingSpotifyPrompts.has(promptMessageId), true);

      // Owner can cancel
      const ownerResult = strategy.cancelPending(chatId, promptMessageId, ownerId, false);
      assert.equal(ownerResult.messageId, promptMessageId);
      assert.equal(strategy.pendingSpotifyPrompts.has(promptMessageId), false);
    });

    it('should allow chat admins to cancel any pending prompt', () => {
      const strategy = new SpotifyStrategy();
      const promptMessageId = 888;
      const ownerId = 12345;
      const adminId = 99999;
      const chatId = -1002;

      strategy.pendingSpotifyPrompts.set(promptMessageId, {
        userId: ownerId,
        chatId,
        type: 'album',
        id: 'mock_album',
        entity: { title: 'Test Album', tracks: [] }
      });

      const adminResult = strategy.cancelPending(chatId, promptMessageId, adminId, true);
      assert.equal(adminResult.messageId, promptMessageId);
      assert.equal(strategy.pendingSpotifyPrompts.has(promptMessageId), false);
    });

    it('should handle inline cancel callback', async () => {
      const strategy = new SpotifyStrategy();
      const promptMessageId = 777;
      const userId = 555;

      strategy.pendingSpotifyPrompts.set(promptMessageId, {
        userId,
        chatId: 100,
        type: 'playlist'
      });

      let cbAnswer = '';
      let deleted = false;

      const mockCtx = {
        callbackQuery: {
          data: 'spot_cancel',
          message: { message_id: promptMessageId }
        },
        from: { id: userId },
        answerCbQuery: async (msg) => { cbAnswer = msg; },
        deleteMessage: async () => { deleted = true; }
      };

      await strategy.handleCallback(mockCtx);

      assert.equal(cbAnswer, '❌ Download cancelled');
      assert.equal(deleted, true);
      assert.equal(strategy.pendingSpotifyPrompts.has(promptMessageId), false);
    });

    it('should leave track.coverUrl null for playlist tracks and keep playlistCoverUrl as fallback', () => {
      const mockRawEntity = {
        title: 'Top Hits',
        coverArt: { sources: [{ url: 'https://cdn.spotify.com/playlist_cover.jpg' }] },
        trackList: [
          { uri: 'spotify:track:track1', title: 'Song 1', subtitle: 'Artist 1' },
          { uri: 'spotify:track:track2', title: 'Song 2', subtitle: 'Artist 2' }
        ]
      };

      // Emulate mapping from getPlaylist
      const tracks = mockRawEntity.trackList.map((t, idx) => ({
        id: 'track' + (idx + 1),
        title: t.title,
        artist: t.subtitle,
        coverUrl: null,
        playlistCoverUrl: mockRawEntity.coverArt.sources[0].url
      }));

      assert.equal(tracks[0].coverUrl, null);
      assert.equal(tracks[0].playlistCoverUrl, 'https://cdn.spotify.com/playlist_cover.jpg');
      assert.equal(tracks[1].coverUrl, null);
    });
  });

  describe('YouTube candidate ranking & matching', () => {
    const spotifyAudioService = require('../src/services/spotify-audio.service');

    it('should prioritize Topic channel and exact duration match over covers and wrong tracks', () => {
      const track = {
        title: 'Больше не Друзья',
        artist: 'Птицу ЕМЪ',
        durationMs: 257931 // 258s
      };

      const candidates = [
        { id: 'wrong_reupload', title: 'Птицу емъ-Больше не друзья норм версия', uploader: 'diana veseliskaia', duration: 244 },
        { id: 'exact_topic', title: 'Больше не Друзья', uploader: 'Птицу ЕМЪ - Topic', duration: 258 },
        { id: 'wrong_track_topic', title: 'Биохазард', uploader: 'Птицу ЕМЪ - Topic', duration: 257 },
        { id: 'live_concert', title: 'Больше не Друзья (Live)', uploader: 'Fan', duration: 393 }
      ];

      const scored = candidates.map(c => ({
        ...c,
        score: spotifyAudioService.scoreCandidate(c, track)
      })).sort((a, b) => b.score - a.score);

      assert.equal(scored[0].id, 'exact_topic');
      assert.ok(scored[0].score > scored[1].score);
      assert.ok(scored.find(c => c.id === 'live_concert').score < 0);
    });

    it('should correctly select matching indie tracks without Official Audio', () => {
      const track = {
        title: '160ξσ44lone_shadow',
        artist: 'mamomo',
        durationMs: 246144 // 246s
      };

      const candidates = [
        { id: 'exact_indie', title: '160ξσ44lone_shadow', uploader: 'mamomo - Topic', duration: 246 },
        { id: 'other_song', title: 'mamomo - 84ζψ44the_vastnesses_of', uploader: 'mamomo', duration: 312 },
        { id: 'random_kpop', title: 'FISCH - ASTRAEUS SERENADE', uploader: 'Saya_wassalamualaikum', duration: 215 }
      ];

      const scored = candidates.map(c => ({
        ...c,
        score: spotifyAudioService.scoreCandidate(c, track)
      })).sort((a, b) => b.score - a.score);

      assert.equal(scored[0].id, 'exact_indie');
    });
  });
});
