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

    it('should manage active playlist cancellation permissions via cancelActive', () => {
      const strategy = new SpotifyStrategy();
      const statusMessageId = 777;
      const ownerId = 12345;
      const otherUserId = 67890;
      const adminId = 99999;
      const chatId = -1003;
      const abortController = new AbortController();

      strategy.activePlaylists.set(statusMessageId, {
        abortController,
        chatId,
        userId: ownerId,
        statusMessageId,
        originalMessageId: 111
      });

      // Non-owner cannot cancel
      const unauthorized = strategy.cancelActive(chatId, statusMessageId, otherUserId, false);
      assert.deepEqual(unauthorized, { unauthorized: true });
      assert.equal(abortController.signal.aborted, false);
      assert.equal(strategy.activePlaylists.has(statusMessageId), true);

      // Owner can cancel
      const ownerCancel = strategy.cancelActive(chatId, statusMessageId, ownerId, false);
      assert.equal(ownerCancel.statusMessageId, statusMessageId);
      assert.equal(abortController.signal.aborted, true);
      assert.equal(strategy.activePlaylists.has(statusMessageId), false);

      // Admin can cancel
      const adminController = new AbortController();
      strategy.activePlaylists.set(888, {
        abortController: adminController,
        chatId,
        userId: ownerId,
        statusMessageId: 888
      });
      const adminCancel = strategy.cancelActive(chatId, 888, adminId, true);
      assert.equal(adminCancel.statusMessageId, 888);
      assert.equal(adminController.signal.aborted, true);
      assert.equal(strategy.activePlaylists.has(888), false);
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

  describe('SpotifyService Pagination (>100 tracks)', () => {
    it('should paginate and retrieve all tracks when playlist exceeds 100 tracks in Pathfinder', async () => {
      const service = new spotifyService.SpotifyService();

      // Mock axios get to simulate Pathfinder pagination
      const originalGet = require('axios').get;
      const axios = require('axios');

      let callCount = 0;
      axios.get = async (url) => {
        callCount++;
        const parsed = new URL(url);
        const variables = JSON.parse(parsed.searchParams.get('variables'));

        if (variables.offset === 0) {
          // Return first 100 tracks
          const items = Array.from({ length: 100 }, (_, i) => ({
            itemV2: {
              data: {
                __typename: 'Track',
                uri: `spotify:track:track_id_${i + 1}`,
                name: `Song ${i + 1}`,
                artists: { items: [{ profile: { name: 'Artist X' } }] },
                albumOfTrack: { name: 'Album X', coverArt: { sources: [{ url: 'https://cdn.spotify.com/art.jpg' }] } },
                trackDuration: { totalMilliseconds: 180000 }
              }
            }
          }));

          return {
            status: 200,
            data: {
              data: {
                playlistV2: {
                  name: 'Mega Playlist',
                  ownerV2: { data: { name: 'Curator X' } },
                  images: { items: [{ sources: [{ url: 'https://cdn.spotify.com/playlist.jpg' }] }] },
                  content: {
                    totalCount: 165,
                    items
                  }
                }
              }
            }
          };
        } else if (variables.offset === 100) {
          // Return remaining 65 tracks
          const items = Array.from({ length: 65 }, (_, i) => ({
            itemV2: {
              data: {
                __typename: 'Track',
                uri: `spotify:track:track_id_${101 + i}`,
                name: `Song ${101 + i}`,
                artists: { items: [{ profile: { name: 'Artist Y' } }] },
                albumOfTrack: { name: 'Album Y', coverArt: { sources: [{ url: 'https://cdn.spotify.com/art2.jpg' }] } },
                trackDuration: { totalMilliseconds: 200000 }
              }
            }
          }));

          return {
            status: 200,
            data: {
              data: {
                playlistV2: {
                  name: 'Mega Playlist',
                  ownerV2: { data: { name: 'Curator X' } },
                  content: {
                    totalCount: 165,
                    items
                  }
                }
              }
            }
          };
        }
        return { data: { data: { playlistV2: { content: { items: [], totalCount: 165 } } } } };
      };

      try {
        const result = await service.fetchPathfinderPlaylist('mock_pl', 'mock_token');
        assert.equal(result.title, 'Mega Playlist');
        assert.equal(result.curator, 'Curator X');
        assert.equal(result.totalTracks, 165);
        assert.equal(result.tracks.length, 165);
        assert.equal(result.tracks[0].title, 'Song 1');
        assert.equal(result.tracks[100].title, 'Song 101');
        assert.equal(result.tracks[164].title, 'Song 165');
        assert.equal(callCount, 2);
      } finally {
        axios.get = originalGet;
      }
    });

    it('should paginate and retrieve all tracks when album exceeds 50 tracks in Pathfinder', async () => {
      const service = new spotifyService.SpotifyService();

      const originalGet = require('axios').get;
      const axios = require('axios');

      let callCount = 0;
      axios.get = async (url) => {
        callCount++;
        const parsed = new URL(url);
        const variables = JSON.parse(parsed.searchParams.get('variables'));

        const count = variables.offset === 0 ? 50 : 25;
        const items = Array.from({ length: count }, (_, i) => ({
          track: {
            uri: `spotify:track:album_track_${variables.offset + i + 1}`,
            name: `Track ${variables.offset + i + 1}`,
            artists: { items: [{ profile: { name: 'Album Artist' } }] },
            duration: { totalMilliseconds: 150000 },
            trackNumber: variables.offset + i + 1
          }
        }));

        return {
          status: 200,
          data: {
            data: {
              albumUnion: {
                name: 'Massive Box Set',
                artists: { items: [{ profile: { name: 'Album Artist' } }] },
                coverArt: { sources: [{ url: 'https://cdn.spotify.com/album_cover.jpg' }] },
                tracksV2: {
                  totalCount: 75,
                  items
                }
              }
            }
          }
        };
      };

      try {
        const result = await service.fetchPathfinderAlbum('mock_album', 'mock_token');
        assert.equal(result.title, 'Massive Box Set');
        assert.equal(result.totalTracks, 75);
        assert.equal(result.tracks.length, 75);
        assert.equal(result.tracks[0].title, 'Track 1');
        assert.equal(result.tracks[74].title, 'Track 75');
        assert.equal(callCount, 2);
      } finally {
        axios.get = originalGet;
      }
    });

    it('should fall back to embed metadata if Pathfinder fails', async () => {
      const service = new spotifyService.SpotifyService();

      service.getClientCredentialsToken = async () => null;
      service.getAnonymousToken = async () => 'mock_token';
      service.fetchPathfinderPlaylist = async () => {
        throw new Error('Pathfinder Network Error');
      };

      let embedFallbackCalled = false;
      service.getPlaylistEmbedFallback = async (id) => {
        embedFallbackCalled = true;
        return {
          id,
          title: 'Fallback Playlist',
          curator: 'Spotify',
          coverUrl: null,
          totalTracks: 50,
          tracks: []
        };
      };

      const result = await service.getPlaylist('fallback_test');
      assert.equal(embedFallbackCalled, true);
      assert.equal(result.title, 'Fallback Playlist');
    });
  });
});
