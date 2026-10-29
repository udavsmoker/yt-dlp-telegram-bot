const axios = require('axios');
const cacheService = require('./cache.service');
const spotifyAudioService = require('./spotify-audio.service');
const spotifyService = require('./spotify.service');
const logger = require('../utils/logger');
const { escapeHtml, formatDuration, isTikTokUrl, isYouTubeUrl, isInstagramUrl } = require('../utils/helpers');

class InlineService {
  constructor() {
    // In-memory query cache to throttle identical queries (TTL: 60s)
    this.queryCache = new Map();
    this.cacheTtlMs = 60 * 1000;
    this.maxCacheSize = 200;
  }

  /**
   * Get cached results for a query if present and not expired.
   * @param {string} key
   * @returns {Array|null}
   */
  getCachedResults(key) {
    const entry = this.queryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.queryCache.delete(key);
      return null;
    }
    return entry.results;
  }

  /**
   * Set cached results for a query.
   * @param {string} key
   * @param {Array} results
   */
  setCachedResults(key, results) {
    if (this.queryCache.size >= this.maxCacheSize) {
      const firstKey = this.queryCache.keys().next().value;
      if (firstKey) this.queryCache.delete(firstKey);
    }
    this.queryCache.set(key, {
      results,
      expiresAt: Date.now() + this.cacheTtlMs
    });
  }

  /**
   * Build onboarding guide articles shown on empty or whitespace queries.
   * @param {string} botUsername
   * @returns {Array<object>}
   */
  buildHelpResults(botUsername) {
    return [
      {
        type: 'article',
        id: 'guide_video',
        title: '🎬 Download Video',
        description: 'Paste a TikTok, Reels, or YouTube URL to share video',
        thumb_url: 'https://cdn-icons-png.flaticon.com/128/1179/1179069.png',
        input_message_content: {
          message_text: (
            '🎬 <b>Video Downloader</b>\n\n' +
            'Type <code>@' + botUsername + ' &lt;video link&gt;</code> in any chat to share media instantly.\n\n' +
            '<b>Supported Platforms:</b>\n' +
            '• TikTok (no watermark)\n' +
            '• Instagram Reels & Posts\n' +
            '• YouTube & Shorts\n' +
            '• Twitter / X, Bluesky, Reddit'
          ),
          parse_mode: 'HTML'
        }
      },
      {
        type: 'article',
        id: 'guide_music',
        title: '🎵 Search & Send Music',
        description: 'Type any track name or artist to find 320 kbps MP3',
        thumb_url: 'https://cdn-icons-png.flaticon.com/128/3844/3844724.png',
        input_message_content: {
          message_text: (
            '🎵 <b>Music Search</b>\n\n' +
            'Type <code>@' + botUsername + ' &lt;song title or artist&gt;</code> to find and send music.\n\n' +
            '<b>Examples:</b>\n' +
            '• <code>@' + botUsername + ' Linkin Park Numb</code>\n' +
            '• <code>@' + botUsername + ' Bohemian Rhapsody</code>\n' +
            '• <code>@' + botUsername + ' Miyagi Minor</code>'
          ),
          parse_mode: 'HTML'
        }
      }
    ];
  }

  /**
   * Resolve an inline query when the input is a URL.
   * @param {string} url
   * @param {string} botUsername
   * @returns {Promise<Array<object>>}
   */
  async resolveUrl(url, botUsername) {
    const results = [];
    const normalizedUrl = cacheService.normalizeUrl(url);

    // 1. Check SQLite cache (instant response with Telegram file_id)
    const cached = cacheService.get(normalizedUrl);
    if (cached && cached.file_id) {
      if (cached.file_type === 'video') {
        results.push({
          type: 'video',
          id: `cache_vid_${cached.id}`,
          video_file_id: cached.file_id,
          title: cached.title || 'Cached Video',
          description: `⚡ Cached Video • ${cached.author || 'Ready'}`,
          caption: cached.caption_info || `📹 <b>${escapeHtml(cached.title || 'Video')}</b>\nvia @${botUsername}`,
          parse_mode: 'HTML'
        });
        return results;
      }
      if (cached.file_type === 'audio') {
        results.push({
          type: 'audio',
          id: `cache_aud_${cached.id}`,
          audio_file_id: cached.file_id,
          title: cached.title || 'Cached Audio',
          performer: cached.author || 'Music',
          caption: cached.caption_info || `🎵 <b>${escapeHtml(cached.title || 'Audio')}</b>\nvia @${botUsername}`,
          parse_mode: 'HTML'
        });
        return results;
      }
      if (cached.file_type === 'photo') {
        results.push({
          type: 'photo',
          id: `cache_photo_${cached.id}`,
          photo_file_id: cached.file_id,
          title: cached.title || 'Photo'
        });
        return results;
      }
    }

    const b64 = Buffer.from(url).toString('base64url');

    // 2. TikTok resolution (fetch direct CDN playUrl without watermark)
    if (isTikTokUrl(url)) {
      try {
        const res = await axios.post('https://www.tikwm.com/api/', { url, hd: 1 }, { timeout: 3500 });
        const data = res.data?.data;
        if (data && data.play) {
          const title = (data.title || 'TikTok Video').substring(0, 100);
          const author = data.author?.nickname || 'TikTok';
          results.push({
            type: 'video',
            id: `tt_${b64.substring(0, 30)}`,
            video_url: data.play,
            mime_type: 'video/mp4',
            thumbnail_url: data.cover || 'https://cdn-icons-png.flaticon.com/128/3046/3046121.png',
            title: title,
            description: `@${author} • TikTok (No Watermark)`,
            caption: `📹 <b>${escapeHtml(title)}</b>\n👤 <i>@${escapeHtml(author)}</i>\nvia @${botUsername}`,
            parse_mode: 'HTML'
          });
          return results;
        }
      } catch (err) {
        logger.warn(`Inline TikTok resolution failed: ${err.message}`);
      }
    }

    // 3. YouTube resolution (fetch metadata via oEmbed)
    if (isYouTubeUrl(url)) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const res = await axios.get(oembedUrl, { timeout: 2500 });
        const title = res.data?.title || 'YouTube Video';
        const author = res.data?.author_name || 'YouTube';
        const thumb = res.data?.thumbnail_url || 'https://cdn-icons-png.flaticon.com/128/1384/1384060.png';

        results.push({
          type: 'article',
          id: `yt_${b64.substring(0, 30)}`,
          title: title,
          description: `${author} • Tap to download`,
          thumb_url: thumb,
          input_message_content: {
            message_text: (
              `🎬 <b><a href="${url}">${escapeHtml(title)}</a></b>\n` +
              `👤 <i>${escapeHtml(author)}</i>\n\n` +
              `<i>Choose download format below:</i>`
            ),
            parse_mode: 'HTML'
          },
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📹 Download Video', url: `https://t.me/${botUsername}?start=dl_${b64}` },
                { text: '🎵 Download MP3', url: `https://t.me/${botUsername}?start=mp3_${b64}` }
              ]
            ]
          }
        });
        return results;
      } catch (err) {
        logger.warn(`Inline YouTube oEmbed failed: ${err.message}`);
      }
    }

    // 4. Spotify track resolution
    if (url.includes('spotify.com/track/')) {
      try {
        const track = await spotifyService.getTrackMetadata(url);
        if (track) {
          results.push({
            type: 'article',
            id: `spot_${b64.substring(0, 30)}`,
            title: track.title,
            description: `${track.artist} • Spotify Track`,
            thumb_url: track.coverUrl || 'https://cdn-icons-png.flaticon.com/128/2111/2111624.png',
            input_message_content: {
              message_text: (
                `🎵 <b>${escapeHtml(track.title)}</b>\n` +
                `👤 <i>${escapeHtml(track.artist)}</i>\n` +
                `💿 Album: <i>${escapeHtml(track.album || 'Single')}</i>\n\n` +
                `<i>Click below to download 320 kbps MP3:</i>`
              ),
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🎵 Download MP3 (320 kbps)', url: `https://t.me/${botUsername}?start=dl_${b64}` }
                ]
              ]
            }
          });
          return results;
        }
      } catch (err) {
        logger.warn(`Inline Spotify track resolution failed: ${err.message}`);
      }
    }

    // 5. Generic fallback article for other platforms
    results.push({
      type: 'article',
      id: `gen_${b64.substring(0, 30)}`,
      title: '📥 Download Media',
      description: url,
      thumb_url: 'https://cdn-icons-png.flaticon.com/128/1179/1179069.png',
      input_message_content: {
        message_text: (
          `📥 <b>Media Downloader</b>\n\n` +
          `<b>Link:</b> <code>${escapeHtml(url)}</code>\n\n` +
          `<i>Click below to start download:</i>`
        ),
        parse_mode: 'HTML'
      },
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🚀 Download Media', url: `https://t.me/${botUsername}?start=dl_${b64}` },
            { text: '🎵 Extract Audio', url: `https://t.me/${botUsername}?start=mp3_${b64}` }
          ]
        ]
      }
    });

    return results;
  }

  /**
   * Search music tracks via Innertube and format as inline results.
   * @param {string} query
   * @param {string} botUsername
   * @returns {Promise<Array<object>>}
   */
  async resolveMusicSearch(query, botUsername) {
    const results = [];
    const tracks = await spotifyAudioService.searchYouTubeTracks(query, 8);

    for (const track of tracks) {
      const ytUrl = `https://www.youtube.com/watch?v=${track.youtubeId}`;
      const cached = cacheService.get(cacheService.normalizeUrl(ytUrl));

      if (cached && cached.file_id && cached.file_type === 'audio') {
        // Instant audio result from 30-day SQLite cache
        results.push({
          type: 'audio',
          id: `aud_cache_${track.youtubeId}`,
          audio_file_id: cached.file_id,
          title: track.title,
          performer: track.artist,
          caption: `🎵 <b>${escapeHtml(track.title)}</b> — <i>${escapeHtml(track.artist)}</i>\nvia @${botUsername}`,
          parse_mode: 'HTML'
        });
      } else {
        // Candidate article with instant download button and deep link
        const durationSec = Math.round(track.durationMs / 1000);
        results.push({
          type: 'article',
          id: `song_art_${track.youtubeId}`,
          title: track.title,
          description: `${track.artist} • ${formatDuration(durationSec)}`,
          thumb_url: `https://i.ytimg.com/vi/${track.youtubeId}/hqdefault.jpg`,
          input_message_content: {
            message_text: (
              `🎵 <b>${escapeHtml(track.title)}</b>\n` +
              `👤 <i>${escapeHtml(track.artist)}</i>\n` +
              `⏱ Duration: <code>${formatDuration(durationSec)}</code>\n\n` +
              `<i>Click below to download:</i>`
            ),
            parse_mode: 'HTML'
          },
          reply_markup: {
            inline_keyboard: [
              [
                { text: '⬇️ Download in Chat', callback_data: `inline_dl:${track.youtubeId}` },
                { text: '🎧 Open in Bot', url: `https://t.me/${botUsername}?start=song_${track.youtubeId}` }
              ]
            ]
          }
        });
      }
    }

    return results;
  }

  /**
   * Master query router: determines whether query is empty, a URL, or a song search.
   * @param {string} rawQuery
   * @param {string} botUsername
   * @returns {Promise<Array<object>>}
   */
  async handleQuery(rawQuery, botUsername) {
    const query = (rawQuery || '').trim();
    if (!query) {
      return this.buildHelpResults(botUsername);
    }

    // Check query cache
    const cacheKey = `${botUsername}:${query.toLowerCase()}`;
    const cachedResults = this.getCachedResults(cacheKey);
    if (cachedResults) {
      return cachedResults;
    }

    let results = [];
    if (/^https?:\/\//i.test(query)) {
      results = await this.resolveUrl(query, botUsername);
    } else {
      results = await this.resolveMusicSearch(query, botUsername);
    }

    if (results.length > 0) {
      this.setCachedResults(cacheKey, results);
    }
    return results;
  }
}

module.exports = new InlineService();
