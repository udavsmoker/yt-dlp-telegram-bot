const axios = require('axios');
const https = require('https');
const logger = require('../utils/logger');
const config = require('../config');

// Use IPv4 agent to avoid IPv6 network resolution delays on Linux
const ipv4Agent = new https.Agent({ family: 4 });

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';
const PLAYLIST_SHA256 = 'a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4';
const ALBUM_SHA256 = 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10';
const SEARCH_SHA256 = 'eff59fa0a3d026b88b56fddbcf4bdfa16a186b8175a5c1a358c072e053c2e5b0';
const DEFAULT_BOOTSTRAP_TRACK_ID = '4uLU6hMCjMI75M1A2tKUQC';

class SpotifyService {
  constructor() {
    this.clientId = config.spotify?.clientId || process.env.SPOTIFY_CLIENT_ID || null;
    this.clientSecret = config.spotify?.clientSecret || process.env.SPOTIFY_CLIENT_SECRET || null;
    this.maxTracks = config.spotify?.maxTracks || 1000;
    this.apiToken = null;
    this.apiTokenExpires = 0;
    this.anonymousToken = null;
    this.anonymousTokenExpires = 0;
  }

  /**
   * Determine whether a URL is a Spotify URL.
   * @param {string} url
   * @returns {boolean}
   */
  isSpotifyUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      if (url.startsWith('spotify:')) return true;
      const parsed = new URL(url.trim());
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      return host === 'open.spotify.com' || host === 'spotify.com' || host === 'spotify.link';
    } catch {
      return false;
    }
  }

  /**
   * Parse entity type and ID from a Spotify URL or URI.
   * @param {string} rawUrl
   * @returns {{ type: 'track'|'album'|'playlist'|'artist', id: string } | null}
   */
  parseUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const url = rawUrl.trim();

    // Check URI format: spotify:track:4cOdK2wGLETKBW3PvgPWqT
    const uriMatch = url.match(/^spotify:(track|album|playlist|artist):([a-zA-Z0-9]+)/i);
    if (uriMatch) {
      return { type: uriMatch[1].toLowerCase(), id: uriMatch[2] };
    }

    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/(?:intl-[a-z]+\/)?(track|album|playlist|artist)\/([a-zA-Z0-9]+)/i);
      if (match) {
        return { type: match[1].toLowerCase(), id: match[2] };
      }
    } catch {}

    return null;
  }

  /**
   * Fetch entity metadata from Spotify embed page (no API keys required).
   * @param {string} type - 'track'|'album'|'playlist'|'artist'
   * @param {string} id - Spotify entity ID
   * @returns {Promise<object>} Raw entity JSON
   */
  async fetchEmbedEntity(type, id) {
    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
    logger.info(`Fetching Spotify embed: ${embedUrl}`);

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await axios.get(embedUrl, {
          httpsAgent: ipv4Agent,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: 15000
        });

        const match = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (!match) {
          throw new Error(`Failed to extract Spotify metadata from embed page for ${type}/${id}`);
        }

        const json = JSON.parse(match[1]);

        // Harvest anonymous session token from embed state whenever available
        const session = json?.props?.pageProps?.state?.settings?.session;
        if (session?.accessToken) {
          this.anonymousToken = session.accessToken;
          this.anonymousTokenExpires = session.accessTokenExpirationTimestampMs || (Date.now() + 3600000);
        }

        const entity = json?.props?.pageProps?.state?.data?.entity;

        if (!entity) {
          const status = json?.props?.pageProps?.status;
          if (status === 404) {
            throw new Error(`Spotify ${type} not found or is private (ID: ${id})`);
          }
          throw new Error(`Invalid Spotify metadata structure for ${type}/${id}`);
        }

        return entity;
      } catch (err) {
        lastError = err;
        if (err.message.includes('not found') || err.message.includes('private')) {
          throw err;
        }
        if (attempt < 3) {
          logger.warn(`Spotify fetch embed attempt ${attempt} failed: ${err.message}. Retrying in ${attempt * 500}ms...`);
          await new Promise(r => setTimeout(r, attempt * 500));
        }
      }
    }

    throw lastError;
  }

  /**
   * Obtain an anonymous access token bootstrapped from a Spotify embed page.
   * @param {string} [seedId]
   * @param {string} [seedType]
   * @returns {Promise<string|null>}
   */
  async getAnonymousToken(seedId = null, seedType = 'track') {
    if (this.anonymousToken && Date.now() < this.anonymousTokenExpires - 60000) {
      return this.anonymousToken;
    }

    const type = seedType || 'track';
    const id = seedId || DEFAULT_BOOTSTRAP_TRACK_ID;
    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;

    try {
      const res = await axios.get(embedUrl, {
        httpsAgent: ipv4Agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 10000
      });

      const match = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (match) {
        const json = JSON.parse(match[1]);
        const session = json?.props?.pageProps?.state?.settings?.session;
        if (session?.accessToken) {
          this.anonymousToken = session.accessToken;
          this.anonymousTokenExpires = session.accessTokenExpirationTimestampMs || (Date.now() + 3600000);
          return this.anonymousToken;
        }
      }
    } catch (err) {
      logger.warn(`Failed to bootstrap Spotify anonymous token: ${err.message}`);
    }

    return null;
  }

  /**
   * Obtain an official Spotify Web API token using Client Credentials flow if configured.
   * @returns {Promise<string|null>}
   */
  async getClientCredentialsToken() {
    if (!this.clientId || !this.clientSecret) {
      return null;
    }

    if (this.apiToken && Date.now() < this.apiTokenExpires - 60000) {
      return this.apiToken;
    }

    try {
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const res = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      });

      if (res.data?.access_token) {
        this.apiToken = res.data.access_token;
        this.apiTokenExpires = Date.now() + (res.data.expires_in || 3600) * 1000;
        return this.apiToken;
      }
    } catch (err) {
      logger.warn(`Failed to obtain Spotify Client Credentials token: ${err.message}`);
    }

    return null;
  }

  /**
   * Get single track information.
   * @param {string} id
   * @returns {Promise<{ id: string, title: string, artist: string, artists: string[], album: string, durationMs: number, releaseDate: string|null, coverUrl: string|null }>}
   */
  async getTrack(id) {
    const entity = await this.fetchEmbedEntity('track', id);

    const title = entity.title || entity.name || 'Unknown Title';
    const artists = (entity.artists || []).map(a => a.name).filter(Boolean);
    const artist = artists.join(', ') || 'Unknown Artist';

    // Find highest resolution cover art
    let coverUrl = null;
    if (entity.visualIdentity?.image && entity.visualIdentity.image.length > 0) {
      const sorted = [...entity.visualIdentity.image].sort((a, b) => (b.maxHeight || 0) - (a.maxHeight || 0));
      coverUrl = sorted[0]?.url || null;
    } else if (entity.coverArt?.sources && entity.coverArt.sources.length > 0) {
      coverUrl = entity.coverArt.sources[0]?.url || null;
    }

    const durationMs = entity.duration || 0;
    const releaseDate = entity.releaseDate?.isoString || null;

    return {
      id,
      title,
      artist,
      artists,
      album: entity.name !== title ? entity.name : title,
      durationMs,
      releaseDate,
      coverUrl
    };
  }

  /**
   * Fetch all tracks from a Spotify playlist using the Pathfinder GraphQL API with automatic pagination.
   * Supports playlists of any size (>100 tracks).
   * @param {string} id
   * @param {string} token
   * @returns {Promise<{ id: string, title: string, curator: string, coverUrl: string|null, totalTracks: number, tracks: Array<object> }>}
   */
  async fetchPathfinderPlaylist(id, token) {
    let currentToken = token;
    let offset = 0;
    const limit = 100;
    const allTracks = [];
    let totalTracks = 0;
    let title = '';
    let curator = '';
    let coverUrl = null;
    let tokenRefreshed = false;

    while (true) {
      const variables = {
        uri: `spotify:playlist:${id}`,
        offset,
        limit,
        enableWatchFeedEntrypoint: false
      };

      const params = new URLSearchParams({
        operationName: 'fetchPlaylist',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: PLAYLIST_SHA256 }
        })
      });

      let res;
      try {
        res = await axios.get(`${PATHFINDER_URL}?${params.toString()}`, {
          httpsAgent: ipv4Agent,
          headers: {
            'Authorization': `Bearer ${currentToken}`,
            'app-platform': 'WebPlayer',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          },
          timeout: 15000
        });
      } catch (err) {
        // If 401 Unauthorized, refresh the anonymous token once and retry
        if (err.response?.status === 401 && !tokenRefreshed) {
          logger.info(`Spotify token expired during playlist pagination. Refreshing token...`);
          this.anonymousToken = null;
          currentToken = await this.getAnonymousToken(id, 'playlist');
          tokenRefreshed = true;
          if (currentToken) continue;
        }
        throw err;
      }

      const pl = res.data?.data?.playlistV2;
      if (!pl) break;

      title = pl.name || title || 'Unknown Playlist';
      curator = pl.ownerV2?.data?.name || curator || 'Spotify';
      if (!coverUrl && pl.images?.items?.length) {
        coverUrl = pl.images.items[0].sources?.[0]?.url || null;
      }

      totalTracks = pl.content?.totalCount || 0;
      const items = pl.content?.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        const trackData = item.itemV2?.data;
        if (!trackData) continue;

        const trackIdMatch = trackData.uri?.match(/spotify:track:([a-zA-Z0-9]+)/);
        const trackId = trackIdMatch ? trackIdMatch[1] : `track_${allTracks.length + 1}`;
        const artists = (trackData.artists?.items || []).map(a => a.profile?.name).filter(Boolean);
        const artist = artists.join(', ') || 'Unknown Artist';
        const trackCover = trackData.albumOfTrack?.coverArt?.sources?.[0]?.url || coverUrl;

        allTracks.push({
          id: trackId,
          title: trackData.name || 'Unknown Title',
          artist,
          artists,
          album: trackData.albumOfTrack?.name || title,
          durationMs: trackData.trackDuration?.totalMilliseconds || 0,
          trackNumber: allTracks.length + 1,
          coverUrl: trackCover,
          playlistCoverUrl: coverUrl,
          releaseDate: trackData.albumOfTrack?.date?.isoString || null
        });

        if (allTracks.length >= this.maxTracks) break;
      }

      offset += items.length;
      if (offset >= totalTracks || allTracks.length >= this.maxTracks) break;
    }

    if (allTracks.length === 0) {
      throw new Error(`No tracks extracted from Spotify Pathfinder for playlist ${id}`);
    }

    return {
      id,
      title,
      curator,
      coverUrl,
      totalTracks: allTracks.length,
      tracks: allTracks
    };
  }

  /**
   * Fetch all tracks from a Spotify album using the Pathfinder GraphQL API with automatic pagination.
   * Supports albums of any size (>50 or >100 tracks).
   * @param {string} id
   * @param {string} token
   * @returns {Promise<{ id: string, title: string, artist: string, coverUrl: string|null, totalTracks: number, tracks: Array<object> }>}
   */
  async fetchPathfinderAlbum(id, token) {
    let currentToken = token;
    let offset = 0;
    const limit = 50;
    const allTracks = [];
    let totalTracks = 0;
    let title = '';
    let artist = '';
    let coverUrl = null;
    let tokenRefreshed = false;

    while (true) {
      const variables = {
        uri: `spotify:album:${id}`,
        locale: '',
        offset,
        limit
      };

      const params = new URLSearchParams({
        operationName: 'getAlbum',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: ALBUM_SHA256 }
        })
      });

      let res;
      try {
        res = await axios.get(`${PATHFINDER_URL}?${params.toString()}`, {
          httpsAgent: ipv4Agent,
          headers: {
            'Authorization': `Bearer ${currentToken}`,
            'app-platform': 'WebPlayer',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          },
          timeout: 15000
        });
      } catch (err) {
        if (err.response?.status === 401 && !tokenRefreshed) {
          logger.info(`Spotify token expired during album pagination. Refreshing token...`);
          this.anonymousToken = null;
          currentToken = await this.getAnonymousToken(id, 'album');
          tokenRefreshed = true;
          if (currentToken) continue;
        }
        throw err;
      }

      const album = res.data?.data?.albumUnion;
      if (!album) break;

      title = album.name || title || 'Unknown Album';
      artist = (album.artists?.items || []).map(a => a.profile?.name).join(', ') || artist || 'Unknown Artist';
      if (!coverUrl && album.coverArt?.sources?.length) {
        coverUrl = album.coverArt.sources[0].url || null;
      }

      totalTracks = album.tracksV2?.totalCount || 0;
      const items = album.tracksV2?.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        const track = item.track;
        if (!track) continue;

        const trackIdMatch = track.uri?.match(/spotify:track:([a-zA-Z0-9]+)/);
        const trackId = trackIdMatch ? trackIdMatch[1] : `track_${allTracks.length + 1}`;
        const trackArtists = (track.artists?.items || []).map(a => a.profile?.name).filter(Boolean);

        allTracks.push({
          id: trackId,
          title: track.name || 'Unknown Title',
          artist: trackArtists.join(', ') || artist || 'Unknown Artist',
          artists: trackArtists,
          album: title,
          durationMs: track.duration?.totalMilliseconds || 0,
          trackNumber: allTracks.length + 1,
          coverUrl
        });

        if (allTracks.length >= this.maxTracks) break;
      }

      offset += items.length;
      if (offset >= totalTracks || allTracks.length >= this.maxTracks) break;
    }

    if (allTracks.length === 0) {
      throw new Error(`No tracks extracted from Spotify Pathfinder for album ${id}`);
    }

    return {
      id,
      title,
      artist,
      coverUrl,
      totalTracks: allTracks.length,
      tracks: allTracks
    };
  }

  /**
   * Fetch playlist via official Spotify Web API (used if client credentials are provided).
   */
  async fetchWebApiPlaylist(id, token) {
    let url = `https://api.spotify.com/v1/playlists/${id}`;
    const allTracks = [];
    let title = '';
    let curator = '';
    let coverUrl = null;

    const res = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000
    });

    title = res.data?.name || 'Unknown Playlist';
    curator = res.data?.owner?.display_name || 'Spotify';
    coverUrl = res.data?.images?.[0]?.url || null;

    let page = res.data?.tracks;
    while (page && page.items) {
      for (const item of page.items) {
        const t = item.track;
        if (!t) continue;
        const artists = (t.artists || []).map(a => a.name).filter(Boolean);
        const trackCover = t.album?.images?.[0]?.url || coverUrl;

        allTracks.push({
          id: t.id || `track_${allTracks.length + 1}`,
          title: t.name || 'Unknown Title',
          artist: artists.join(', ') || 'Unknown Artist',
          artists,
          album: t.album?.name || title,
          durationMs: t.duration_ms || 0,
          trackNumber: allTracks.length + 1,
          coverUrl: trackCover,
          playlistCoverUrl: coverUrl,
          releaseDate: t.album?.release_date || null
        });

        if (allTracks.length >= this.maxTracks) break;
      }

      if (page.next && allTracks.length < this.maxTracks) {
        const nextRes = await axios.get(page.next, {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 15000
        });
        page = nextRes.data;
      } else {
        break;
      }
    }

    return {
      id,
      title,
      curator,
      coverUrl,
      totalTracks: allTracks.length,
      tracks: allTracks
    };
  }

  /**
   * Fetch album via official Spotify Web API (used if client credentials are provided).
   */
  async fetchWebApiAlbum(id, token) {
    const url = `https://api.spotify.com/v1/albums/${id}`;
    const allTracks = [];

    const res = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000
    });

    const title = res.data?.name || 'Unknown Album';
    const artist = (res.data?.artists || []).map(a => a.name).join(', ') || 'Unknown Artist';
    const coverUrl = res.data?.images?.[0]?.url || null;
    const releaseDate = res.data?.release_date || null;

    let page = res.data?.tracks;
    while (page && page.items) {
      for (const t of page.items) {
        const artists = (t.artists || []).map(a => a.name).filter(Boolean);

        allTracks.push({
          id: t.id || `track_${allTracks.length + 1}`,
          title: t.name || 'Unknown Title',
          artist: artists.join(', ') || artist,
          artists,
          album: title,
          durationMs: t.duration_ms || 0,
          trackNumber: allTracks.length + 1,
          coverUrl,
          releaseDate
        });

        if (allTracks.length >= this.maxTracks) break;
      }

      if (page.next && allTracks.length < this.maxTracks) {
        const nextRes = await axios.get(page.next, {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 15000
        });
        page = nextRes.data;
      } else {
        break;
      }
    }

    return {
      id,
      title,
      artist,
      coverUrl,
      totalTracks: allTracks.length,
      tracks: allTracks
    };
  }

  /**
   * Fallback album parser using embed metadata (capped at first 100 tracks).
   */
  async getAlbumEmbedFallback(id) {
    const entity = await this.fetchEmbedEntity('album', id);

    const title = entity.title || entity.name || 'Unknown Album';
    const artist = entity.subtitle || (entity.artists || []).map(a => a.name).join(', ') || 'Unknown Artist';

    let coverUrl = null;
    if (entity.coverArt?.sources && entity.coverArt.sources.length > 0) {
      coverUrl = entity.coverArt.sources[0].url;
    } else if (entity.visualIdentity?.image && entity.visualIdentity.image.length > 0) {
      const sorted = [...entity.visualIdentity.image].sort((a, b) => (b.maxHeight || 0) - (a.maxHeight || 0));
      coverUrl = sorted[0]?.url || null;
    }

    const tracks = (entity.trackList || []).map((t, idx) => {
      const trackIdMatch = t.uri?.match(/spotify:track:([a-zA-Z0-9]+)/);
      const trackId = trackIdMatch ? trackIdMatch[1] : `track_${idx + 1}`;
      return {
        id: trackId,
        title: t.title || 'Unknown Title',
        artist: t.subtitle || artist,
        album: title,
        durationMs: t.duration || 0,
        trackNumber: idx + 1,
        coverUrl
      };
    });

    return {
      id,
      title,
      artist,
      coverUrl,
      totalTracks: tracks.length,
      tracks
    };
  }

  /**
   * Fallback playlist parser using embed metadata (capped at first 100 tracks).
   */
  async getPlaylistEmbedFallback(id) {
    const entity = await this.fetchEmbedEntity('playlist', id);

    const title = entity.title || entity.name || 'Unknown Playlist';
    const curator = entity.subtitle || (entity.authors || []).map(a => a.name).join(', ') || 'Spotify';

    let coverUrl = null;
    if (entity.coverArt?.sources && entity.coverArt.sources.length > 0) {
      coverUrl = entity.coverArt.sources[0].url;
    } else if (entity.visualIdentity?.image && entity.visualIdentity.image.length > 0) {
      const sorted = [...entity.visualIdentity.image].sort((a, b) => (b.maxHeight || 0) - (a.maxHeight || 0));
      coverUrl = sorted[0]?.url || null;
    }

    const tracks = (entity.trackList || []).map((t, idx) => {
      const trackIdMatch = t.uri?.match(/spotify:track:([a-zA-Z0-9]+)/);
      const trackId = trackIdMatch ? trackIdMatch[1] : `track_${idx + 1}`;
      return {
        id: trackId,
        title: t.title || 'Unknown Title',
        artist: t.subtitle || 'Unknown Artist',
        album: title,
        durationMs: t.duration || 0,
        trackNumber: idx + 1,
        coverUrl: null,
        playlistCoverUrl: coverUrl
      };
    });

    return {
      id,
      title,
      curator,
      coverUrl,
      totalTracks: tracks.length,
      tracks
    };
  }

  /**
   * Get album information and its complete track list.
   * Uses Spotify Pathfinder GraphQL or official Web API with full pagination,
   * with graceful fallback to embed scraping.
   * @param {string} id
   * @returns {Promise<{ id: string, title: string, artist: string, coverUrl: string|null, totalTracks: number, tracks: Array<object> }>}
   */
  async getAlbum(id) {
    // 1. Try official Spotify Web API if client credentials are configured
    const apiToken = await this.getClientCredentialsToken();
    if (apiToken) {
      try {
        return await this.fetchWebApiAlbum(id, apiToken);
      } catch (err) {
        logger.warn(`Official Spotify API album fetch failed: ${err.message}. Trying Pathfinder...`);
      }
    }

    // 2. Try Pathfinder GraphQL using anonymous bearer token (retrieves all tracks)
    try {
      const anonToken = await this.getAnonymousToken(id, 'album');
      if (anonToken) {
        return await this.fetchPathfinderAlbum(id, anonToken);
      }
    } catch (err) {
      logger.warn(`Spotify Pathfinder album fetch failed for ${id}: ${err.message}. Falling back to embed...`);
    }

    // 3. Fallback to basic embed scraping
    return await this.getAlbumEmbedFallback(id);
  }

  /**
   * Get playlist information and its complete track list.
   * Uses Spotify Pathfinder GraphQL or official Web API with full pagination,
   * with graceful fallback to embed scraping.
   * @param {string} id
   * @returns {Promise<{ id: string, title: string, curator: string, coverUrl: string|null, totalTracks: number, tracks: Array<object> }>}
   */
  async getPlaylist(id) {
    // 1. Try official Spotify Web API if client credentials are configured
    const apiToken = await this.getClientCredentialsToken();
    if (apiToken) {
      try {
        return await this.fetchWebApiPlaylist(id, apiToken);
      } catch (err) {
        logger.warn(`Official Spotify API playlist fetch failed: ${err.message}. Trying Pathfinder...`);
      }
    }

    // 2. Try Pathfinder GraphQL using anonymous bearer token (retrieves all >100 tracks)
    try {
      const anonToken = await this.getAnonymousToken(id, 'playlist');
      if (anonToken) {
        return await this.fetchPathfinderPlaylist(id, anonToken);
      }
    } catch (err) {
      logger.warn(`Spotify Pathfinder playlist fetch failed for ${id}: ${err.message}. Falling back to embed...`);
    }

    // 3. Fallback to basic embed scraping
    return await this.getPlaylistEmbedFallback(id);
  }

  /**
   * Search for tracks by name or artist across Spotify and YouTube fallback.
   * @param {string} query
   * @param {number} [limit=5]
   * @returns {Promise<Array<{ id: string, title: string, artist: string, artists: string[], album: string, durationMs: number, coverUrl: string|null, releaseDate: string|null, youtubeId?: string }>>}
   */
  async searchTracks(query, limit = 5) {
    if (!query || typeof query !== 'string') return [];
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    // 1. Try official Spotify Web API if client credentials configured
    const apiToken = await this.getClientCredentialsToken();
    if (apiToken) {
      try {
        const res = await axios.get('https://api.spotify.com/v1/search', {
          params: { q: cleanQuery, type: 'track', limit },
          headers: { 'Authorization': `Bearer ${apiToken}` },
          timeout: 10000
        });
        const items = res.data?.tracks?.items || [];
        if (items.length > 0) {
          return items.map(t => {
            const artists = (t.artists || []).map(a => a.name).filter(Boolean);
            return {
              id: t.id,
              title: t.name || 'Unknown Title',
              artist: artists.join(', ') || 'Unknown Artist',
              artists,
              album: t.album?.name || t.name,
              durationMs: t.duration_ms || 0,
              coverUrl: t.album?.images?.[0]?.url || null,
              releaseDate: t.album?.release_date || null
            };
          });
        }
      } catch (err) {
        logger.warn(`Official Spotify search failed: ${err.message}. Trying Pathfinder...`);
      }
    }

    // 2. Try Pathfinder GraphQL searchDesktop with anonymous token
    try {
      const anonToken = await this.getAnonymousToken();
      if (anonToken) {
        const variables = {
          searchTerm: cleanQuery,
          offset: 0,
          limit,
          numberOfTopResults: limit,
          includeAudiobooks: false,
          includePreReleases: false,
          includeAlbumPreReleases: false,
          includeAuthors: false,
          includeEpisodeContentRatingsV2: false
        };

        const params = new URLSearchParams({
          operationName: 'searchDesktop',
          variables: JSON.stringify(variables),
          extensions: JSON.stringify({
            persistedQuery: { version: 1, sha256Hash: SEARCH_SHA256 }
          })
        });

        const res = await axios.get(`${PATHFINDER_URL}?${params.toString()}`, {
          httpsAgent: ipv4Agent,
          headers: {
            'Authorization': `Bearer ${anonToken}`,
            'app-platform': 'WebPlayer',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          },
          timeout: 10000
        });

        const items = res.data?.data?.searchV2?.tracksV2?.items || [];
        const results = [];
        for (const t of items) {
          const d = t.item?.data;
          if (!d || d.__typename !== 'Track') continue;
          const trackIdMatch = d.uri?.match(/spotify:track:([a-zA-Z0-9]+)/);
          const trackId = trackIdMatch ? trackIdMatch[1] : (d.id || `track_${results.length + 1}`);
          const artists = (d.artists?.items || []).map(a => a.profile?.name).filter(Boolean);

          results.push({
            id: trackId,
            title: d.name || 'Unknown Title',
            artist: artists.join(', ') || 'Unknown Artist',
            artists,
            album: d.albumOfTrack?.name || d.name,
            durationMs: d.duration?.totalMilliseconds || 0,
            coverUrl: d.albumOfTrack?.coverArt?.sources?.[0]?.url || null,
            releaseDate: d.albumOfTrack?.date?.isoString || null
          });
        }

        if (results.length > 0) {
          return results;
        }
      }
    } catch (err) {
      logger.warn(`Spotify Pathfinder track search failed for "${cleanQuery}": ${err.message}`);
    }

    // 3. Fallback to direct YouTube search
    try {
      const spotifyAudioService = require('./spotify-audio.service');
      return await spotifyAudioService.searchYouTubeTracks(cleanQuery, limit);
    } catch (err) {
      logger.error(`YouTube track search fallback error for "${cleanQuery}":`, err);
      return [];
    }
  }
}

const instance = new SpotifyService();
instance.SpotifyService = SpotifyService;
module.exports = instance;
