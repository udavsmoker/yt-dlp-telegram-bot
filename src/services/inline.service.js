const axios = require('axios');
const cacheService = require('./cache.service');
const spotifyAudioService = require('./spotify-audio.service');
const spotifyService = require('./spotify.service');
const logger = require('../utils/logger');
const { escapeHtml, formatDuration, isTikTokUrl, isYouTubeUrl, isInstagramUrl, formatCount } = require('../utils/helpers');

class InlineService {
  constructor() {
    // In-memory query cache to throttle identical queries (TTL: 60s)
    this.queryCache = new Map();
    this.cacheTtlMs = 60 * 1000;
    this.maxCacheSize = 200;

    // Track metadata store for chosen inline results (TTL: 10 minutes)
    this.pendingTracks = new Map();

    // Shortlink store for deep-links and inline media resolution (TTL: 24h)
    this.shortLinks = new Map();
  }

  /**
   * Create a short identifier (<= 12 chars) for inline callbacks and deep-links.
   * @param {string} url
   * @returns {string}
   */
  createShortLink(url) {
    const token = 's_' + Math.random().toString(36).substring(2, 10);
    this.shortLinks.set(token, {
      url,
      expiresAt: Date.now() + 24 * 3600 * 1000
    });
    return token;
  }

  /**
   * Retrieve original URL from a short token.
   * @param {string} token
   * @returns {string|null}
   */
  getShortLink(token) {
    const entry = this.shortLinks.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.shortLinks.delete(token);
      return null;
    }
    return entry.url;
  }

  /**
   * Store pending track metadata for background synthesis when chosen by user.
   * @param {string} key
   * @param {object} track
   */
  setPendingTrack(key, track) {
    this.pendingTracks.set(key, {
      ...track,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
  }

  /**
   * Retrieve pending track metadata.
   * @param {string} key
   * @returns {object|null}
   */
  getPendingTrack(key) {
    const entry = this.pendingTracks.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.pendingTracks.delete(key);
      return null;
    }
    return entry;
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
            '• TikTok (1080p Full HD & Photo Slideshows)\n' +
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
        description: 'Type any track name or artist to download 320 kbps MP3',
        thumb_url: 'https://cdn-icons-png.flaticon.com/128/3844/3844724.png',
        input_message_content: {
          message_text: (
            '🎵 <b>Music Downloader & Search</b>\n\n' +
            'Type <code>@' + botUsername + ' &lt;song title or artist&gt;</code> to find and download music directly.\n\n' +
            '<b>Examples:</b>\n' +
            '• <code>@' + botUsername + ' Linkin Park Numb</code>\n' +
            '• <code>@' + botUsername + ' Bohemian Rhapsody</code>\n' +
            '• <code>@' + botUsername + ' https://open.spotify.com/track/...</code>'
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
        const cleanAuthor = cached.author ? cached.author.replace(/^@/, '') : '';
        const caption = cleanAuthor ? `👤 <b>@${escapeHtml(cleanAuthor)}</b>` : undefined;
        const targetUrl = cached.original_url || cached.normalized_url || url;
        results.push({
          type: 'video',
          id: `cache_vid_${cached.id}`,
          video_file_id: cached.file_id,
          title: cached.title || 'Cached Video',
          description: `⚡ Instant Video • ${cached.author || 'Ready'}`,
          ...(caption ? { caption, parse_mode: 'HTML' } : {}),
          reply_markup: {
            inline_keyboard: [
              [
                { text: '↗️', url: targetUrl }
              ]
            ]
          }
        });
        return results;
      }
      if (cached.file_type === 'audio') {
        results.push({
          type: 'audio',
          id: `cache_aud_${cached.id}`,
          audio_file_id: cached.file_id,
          title: cached.title || 'Cached Audio',
          performer: cached.author || 'Music'
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

    // 2. TikTok resolution (prioritize 1080p Full HD stream and handle photo slideshows)
    if (isTikTokUrl(url)) {
      try {
        const res = await axios.post('https://www.tikwm.com/api/', { url, hd: 1 }, { timeout: 4000 });
        const data = res.data?.data;
        if (data) {
          const title = (data.title || 'TikTok Media').substring(0, 100);
          const author = data.author?.nickname || data.author?.unique_id || 'TikTok';
          const cleanAuthor = author.replace(/^@/, '');

          // A. Photo Slideshow post: return photos and original audio
          if (data.images && Array.isArray(data.images) && data.images.length > 0) {
            const shortId = this.createShortLink(url);
            for (let i = 0; i < Math.min(data.images.length, 10); i++) {
              results.push({
                type: 'photo',
                id: `tt_img_${i}_${shortId}`,
                photo_url: data.images[i],
                thumbnail_url: data.images[i],
                title: `Photo ${i + 1}/${data.images.length}`,
                caption: `👤 <b>@${escapeHtml(cleanAuthor)}</b> (${i + 1}/${data.images.length})`,
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '↗️', url }
                    ]
                  ]
                }
              });
            }

            // Also attach background audio if available (clean, no duplicate caption)
            const musicUrl = data.music_info?.play || data.music || data.play;
            if (musicUrl) {
              results.push({
                type: 'audio',
                id: `tt_aud_${shortId}`,
                audio_url: musicUrl,
                title: data.music_info?.title || `${title} (Sound)`,
                performer: data.music_info?.author || author
              });
            }
            return results;
          }

          // B. Video post: use hdplay (1080p) over play (576p)
          const videoUrl = data.hdplay || data.play;
          if (videoUrl) {
            const shortId = this.createShortLink(url);
            const buttons = [];
            if (data.digg_count !== undefined && data.comment_count !== undefined) {
              buttons.push([
                { text: `❤️ ${formatCount(data.digg_count)}`, url },
                { text: `💬 ${formatCount(data.comment_count)}`, url },
                { text: '↗️', url }
              ]);
            } else {
              buttons.push([
                { text: '↗️', url }
              ]);
            }

            results.push({
              type: 'video',
              id: `tt_vid_${shortId}`,
              video_url: videoUrl,
              mime_type: 'video/mp4',
              thumbnail_url: data.cover || 'https://cdn-icons-png.flaticon.com/128/3046/3046121.png',
              title: title,
              description: `@${author} • TikTok HD (1080p)`,
              caption: `👤 <b>@${escapeHtml(cleanAuthor)}</b>`,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: buttons
              }
            });
            return results;
          }
        }
      } catch (err) {
        logger.warn(`Inline TikTok resolution failed: ${err.message}`);
      }
    }

    // 3. Spotify resolution (tracks)
    if (spotifyService.isSpotifyUrl(url)) {
      const parsed = spotifyService.parseUrl(url);
      if (parsed && parsed.type === 'track') {
        try {
          const track = await spotifyService.getTrack(parsed.id);
          if (track) {
            const trackPayload = {
              id: `spot_${parsed.id}`,
              spotifyId: parsed.id,
              title: track.title,
              artist: track.artist,
              album: track.album || track.title,
              coverUrl: track.coverUrl,
              durationMs: track.durationMs || 0
            };
            this.setPendingTrack(`spot_${parsed.id}`, trackPayload);

            results.push({
              type: 'article',
              id: `spot_${parsed.id}`,
              title: track.title,
              description: `${track.artist} • 320 kbps MP3`,
              thumb_url: track.coverUrl || 'https://cdn-icons-png.flaticon.com/128/2111/2111624.png',
              input_message_content: {
                message_text: `⏳ <b>Downloading:</b> ${escapeHtml(track.artist)} — ${escapeHtml(track.title)}...`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '⬇️ Download (320 kbps MP3)', callback_data: `inline_dl:spot_${parsed.id}` }
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
    }

    // 4. Instagram resolution (download directly into chat)
    if (isInstagramUrl(url)) {
      const shortToken = this.createShortLink(url);
      results.push({
        type: 'article',
        id: `ig_${shortToken}`,
        title: '📹 Instagram Media',
        description: 'Tap to download directly into this chat',
        thumb_url: 'https://cdn-icons-png.flaticon.com/128/2111/2111463.png',
        input_message_content: {
          message_text: '⏳ <b>Downloading Instagram media...</b>',
          parse_mode: 'HTML'
        },
        reply_markup: {
          inline_keyboard: [
            [
              { text: '⬇️ Download Video', callback_data: `inline_dl:ig_${shortToken}` }
            ]
          ]
        }
      });
      return results;
    }

    // 5. YouTube resolution (Shorts directly in-chat, long videos offer bot PM with quality selector + direct option)
    if (isYouTubeUrl(url)) {
      const shortToken = this.createShortLink(url);
      const isShort = url.includes('/shorts/');
      let title = isShort ? 'YouTube Short' : 'YouTube Video';
      let author = 'YouTube';
      let thumb = 'https://cdn-icons-png.flaticon.com/128/1384/1384060.png';

      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const res = await axios.get(oembedUrl, { timeout: 2500 });
        if (res.data?.title) title = res.data.title;
        if (res.data?.author_name) author = res.data.author_name;
        if (res.data?.thumbnail_url) thumb = res.data.thumbnail_url;
      } catch {}

      if (isShort) {
        // Shorts download directly into chat
        results.push({
          type: 'article',
          id: `yt_${shortToken}`,
          title: `⚡ ${title}`,
          description: `${author} • YouTube Short • Tap to download to chat`,
          thumb_url: thumb,
          input_message_content: {
            message_text: `⏳ <b>Downloading Short:</b> ${escapeHtml(title)}...`,
            parse_mode: 'HTML'
          },
          reply_markup: {
            inline_keyboard: [
              [
                { text: '⬇️ Download Shorts to chat', callback_data: `inline_dl:yt_${shortToken}` }
              ]
            ]
          }
        });
      } else {
        // Full YouTube videos: primary choice redirects to bot PM with quality selector (1080p/720p/MP3)
        results.push({
          type: 'article',
          id: `yt_pm_${shortToken}`,
          title: `🎬 ${title}`,
          description: `${author} • Quality selector in bot (1080p / 720p / MP3)`,
          thumb_url: thumb,
          input_message_content: {
            message_text: (
              `🎬 <b>${escapeHtml(title)}</b>\n` +
              `👤 <i>${escapeHtml(author)}</i>\n\n` +
              `<i>Tap the button below to choose video quality (1080p, 720p, 480p or MP3) in bot:</i>`
            ),
            parse_mode: 'HTML'
          },
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🚀 Download in Bot (1080p / 720p / MP3)', url: `https://t.me/${botUsername}?start=${shortToken}` }
              ]
            ]
          }
        });

        // Also offer direct in-chat download card for convenience
        results.push({
          type: 'article',
          id: `yt_${shortToken}`,
          title: `⚡ Download to chat: ${title}`,
          description: `${author} • Download video directly into this chat`,
          thumb_url: thumb,
          input_message_content: {
            message_text: `⏳ <b>Downloading:</b> ${escapeHtml(title)}...`,
            parse_mode: 'HTML'
          },
          reply_markup: {
            inline_keyboard: [
              [
                { text: '⬇️ Download video to this chat', callback_data: `inline_dl:yt_${shortToken}` }
              ]
            ]
          }
        });
      }

      return results;
    }

    // 6. Generic fallback article for other platforms
    const shortToken = this.createShortLink(url);
    results.push({
      type: 'article',
      id: `gen_${shortToken}`,
      title: '📥 Download Media',
      description: url,
      thumb_url: 'https://cdn-icons-png.flaticon.com/128/1179/1179069.png',
      input_message_content: {
        message_text: '⏳ <b>Downloading media...</b>',
        parse_mode: 'HTML'
      },
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⬇️ Download Media', callback_data: `inline_dl:gen_${shortToken}` }
          ]
        ]
      }
    });

    return results;
  }

  /**
   * Search music tracks via Innertube and format as inline results.
   * Auto-triggers background synthesis into chat when tapped.
   * @param {string} query
   * @param {string} botUsername
   * @returns {Promise<Array<object>>}
   */
  async resolveMusicSearch(query, botUsername) {
    const results = [];
    // Prioritize pristine Spotify metadata & official album covers, with auto-fallback to YouTube
    const tracks = await spotifyService.searchTracks(query, 8);

    for (const track of tracks) {
      const isYtFallback = !!track.youtubeId;
      const targetUrl = isYtFallback
        ? `https://www.youtube.com/watch?v=${track.youtubeId}`
        : `https://open.spotify.com/track/${track.id}`;

      const cached = cacheService.get(cacheService.normalizeUrl(targetUrl));

      if (cached && cached.file_id && cached.file_type === 'audio') {
        // Instant audio result from 30-day SQLite cache (clean, no duplicate caption)
        results.push({
          type: 'audio',
          id: `aud_cache_${track.id}`,
          audio_file_id: cached.file_id,
          title: track.title,
          performer: track.artist
        });
      } else {
        // Candidate article that triggers automatic download on tap via chosen_inline_result
        const durationSec = Math.round((track.durationMs || 0) / 1000);
        const resultKey = isYtFallback ? `song_${track.youtubeId}` : `spot_${track.id}`;

        const trackPayload = {
          id: resultKey,
          spotifyId: isYtFallback ? null : track.id,
          youtubeId: isYtFallback ? track.youtubeId : null,
          title: track.title,
          artist: track.artist,
          album: track.album || track.title,
          coverUrl: track.coverUrl || (isYtFallback ? `https://i.ytimg.com/vi/${track.youtubeId}/hqdefault.jpg` : null),
          durationMs: track.durationMs || 0
        };
        this.setPendingTrack(resultKey, trackPayload);

        const thumb = track.coverUrl || (isYtFallback ? `https://i.ytimg.com/vi/${track.youtubeId}/hqdefault.jpg` : 'https://cdn-icons-png.flaticon.com/128/2111/2111624.png');

        results.push({
          type: 'article',
          id: resultKey,
          title: track.title,
          description: `${track.artist} • ${formatDuration(durationSec)} • 320 kbps MP3`,
          thumb_url: thumb,
          input_message_content: {
            message_text: `⏳ <b>Downloading:</b> ${escapeHtml(track.artist)} — ${escapeHtml(track.title)}...`,
            parse_mode: 'HTML'
          },
          reply_markup: {
            inline_keyboard: [
              [
                { text: '⬇️ Download (320 kbps MP3)', callback_data: `inline_dl:${resultKey}` }
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
