const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { handleSearchCommand, handleSearchCallback, cancelPendingSearch, pendingSearches } = require('../src/handlers/search.handler');
const spotifyService = require('../src/services/spotify.service');
const queueService = require('../src/services/queue.service');

describe('Song Search Handler & Interface', () => {
  it('should display help guide when /song or /music is called with no query', async () => {
    let replyText = '';
    let replyOpts = null;

    const mockCtx = {
      message: { text: '/song' },
      from: { id: 123 },
      chat: { id: 100 },
      reply: async (text, opts) => {
        replyText = text;
        replyOpts = opts;
      }
    };

    await handleSearchCommand(mockCtx);

    assert.ok(replyText.includes('Music Search'));
    assert.ok(replyText.includes('/song &lt;title or artist&gt;'));
    assert.equal(replyOpts?.parse_mode, 'HTML');
  });

  it('should ignore Telegraf next middleware function passed as second parameter and parse query from text', async () => {
    const originalSearch = spotifyService.searchTracks;
    let searchedQuery = '';
    spotifyService.searchTracks = async (q) => {
      searchedQuery = q;
      return [];
    };

    const mockCtx = {
      message: { message_id: 1, text: '/song сны овсянкин' },
      from: { id: 123 },
      chat: { id: 100 },
      reply: async () => ({ message_id: 2 }),
      telegram: { editMessageText: async () => {} }
    };

    const nextMiddleware = async () => {};

    try {
      await handleSearchCommand(mockCtx, nextMiddleware);
      assert.equal(searchedQuery, 'сны овсянкин');
    } finally {
      spotifyService.searchTracks = originalSearch;
    }
  });

  it('should search tracks and render interactive keyboard with results', async () => {
    const originalSearch = spotifyService.searchTracks;
    spotifyService.searchTracks = async (q, limit) => {
      assert.equal(q, 'Numb Linkin Park');
      return [
        {
          id: 'track1',
          title: 'Numb',
          artist: 'Linkin Park',
          album: 'Meteora',
          durationMs: 187000,
          coverUrl: 'https://cdn.spotify.com/numb.jpg'
        },
        {
          id: 'track2',
          title: 'Numb / Encore',
          artist: 'Jay-Z, Linkin Park',
          album: 'Collision Course',
          durationMs: 205000,
          coverUrl: 'https://cdn.spotify.com/encore.jpg'
        }
      ];
    };

    let statusMsg = '';
    let editedMsg = '';
    let editedOpts = null;

    const mockCtx = {
      message: { message_id: 11, text: '/music Numb Linkin Park' },
      from: { id: 500, username: 'testuser' },
      chat: { id: 200, type: 'private' },
      reply: async (text) => {
        statusMsg = text;
        return { message_id: 99 };
      },
      telegram: {
        editMessageText: async (chatId, msgId, inlineMsgId, text, opts) => {
          editedMsg = text;
          editedOpts = opts;
        }
      }
    };

    try {
      await handleSearchCommand(mockCtx);

      assert.ok(statusMsg.includes('Searching for'));
      assert.ok(editedMsg.includes('Search results for:'));
      assert.ok(editedMsg.includes('Numb</b> — Linkin Park'));
      assert.ok(editedMsg.includes('Meteora'));
      assert.ok(editedMsg.includes('Numb / Encore'));

      // Check inline buttons
      const keyboard = editedOpts.reply_markup.inline_keyboard;
      assert.equal(keyboard.length, 2); // 1 row with 2 tracks, 1 cancel row
      assert.equal(keyboard[0].length, 2);
      assert.ok(keyboard[0][0].text.includes('Numb'));
      assert.ok(keyboard[0][1].text.includes('Numb / Encore'));
      assert.equal(keyboard[1][0].text, '❌ Cancel');

      // Verify pending search session stored
      assert.equal(pendingSearches.size, 1);
      const session = Array.from(pendingSearches.values())[0];
      assert.equal(session.userId, 500);
      assert.equal(session.tracks.length, 2);
    } finally {
      spotifyService.searchTracks = originalSearch;
      pendingSearches.clear();
    }
  });

  it('should notify user when no tracks are found', async () => {
    const originalSearch = spotifyService.searchTracks;
    spotifyService.searchTracks = async () => [];

    let editedMsg = '';
    const mockCtx = {
      message: { message_id: 12, text: '/song non_existent_gibberish_song_xyz' },
      from: { id: 500 },
      chat: { id: 200, type: 'private' },
      reply: async () => ({ message_id: 88 }),
      telegram: {
        editMessageText: async (chatId, msgId, inlineMsgId, text) => {
          editedMsg = text;
        },
        deleteMessage: async () => {}
      }
    };

    try {
      await handleSearchCommand(mockCtx);
      assert.ok(editedMsg.includes('No songs found'));
    } finally {
      spotifyService.searchTracks = originalSearch;
    }
  });

  it('should cancel search prompt on s_cancel callback', async () => {
    const searchId = 'test_cancel_id';
    pendingSearches.set(searchId, {
      userId: 777,
      chatId: 100,
      statusMessageId: 55
    });

    let answered = '';
    let deleted = false;

    const mockCtx = {
      callbackQuery: { data: `s_cancel_${searchId}` },
      from: { id: 777 },
      answerCbQuery: async (msg) => { answered = msg; },
      deleteMessage: async () => { deleted = true; }
    };

    await handleSearchCallback(mockCtx);

    assert.equal(answered, '❌ Search cancelled');
    assert.equal(deleted, true);
    assert.equal(pendingSearches.has(searchId), false);
  });

  it('should prevent unauthorized users from selecting songs or cancelling', async () => {
    const searchId = 'test_perm_id';
    pendingSearches.set(searchId, {
      userId: 111,
      chatId: 100,
      statusMessageId: 55,
      tracks: [{ title: 'Song 1', artist: 'Artist 1' }]
    });

    let alertMsg = '';
    const mockCtx = {
      callbackQuery: { data: `s_dl_${searchId}_0` },
      from: { id: 999 }, // Different user
      answerCbQuery: async (msg) => { alertMsg = msg; },
      deleteMessage: async () => {}
    };

    await handleSearchCallback(mockCtx);

    assert.ok(alertMsg.includes('Only the person who searched'));
    assert.equal(pendingSearches.has(searchId), true);
    pendingSearches.clear();
  });

  it('should cancel pending search via cancelPendingSearch', () => {
    const searchId = 'cancel_search_1';
    pendingSearches.set(searchId, {
      userId: 555,
      chatId: 300,
      statusMessageId: 444
    });

    // Unauthorized cancel
    const unauth = cancelPendingSearch(300, 444, 999, false);
    assert.deepEqual(unauth, { unauthorized: true });
    assert.equal(pendingSearches.has(searchId), true);

    // Authorized cancel
    const auth = cancelPendingSearch(300, 444, 555, false);
    assert.equal(auth.messageId, 444);
    assert.equal(pendingSearches.has(searchId), false);
  });
});
