const axios = require('axios');
const https = require('https');
const logger = require('../utils/logger');
const config = require('../config');

// Use IPv4 agent to avoid IPv6 network resolution delays on Linux
const ipv4Agent = new https.Agent({ family: 4 });

class SpotifyService {
  constructor() {
    this.clientId = config.spotify?.clientId || process.env.SPOTIFY_CLIENT_ID || null;
    this.clientSecret = config.spotify?.clientSecret || process.env.SPOTIFY_CLIENT_SECRET || null;
    this.apiToken = null;
    this.apiTokenExpires = 0;
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
        const entity = json?.props?.pageProps?.state?.data?.entity;

        if (!entity) {
          const status = json?.props?.pageProps?.status;
          if (status === 404) {
            throw new Error(`Spotify ${type} not found (ID: ${id})`);
          }
          throw new Error(`Invalid Spotify metadata structure for ${type}/${id}`);
        }

        return entity;
      } catch (err) {
        lastError = err;
        if (err.message.includes('not found')) {
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
      // Pick the image with highest maxHeight or the last one
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
   * Get album information and its track list.
   * @param {string} id
   * @returns {Promise<{ id: string, title: string, artist: string, coverUrl: string|null, totalTracks: number, tracks: Array<{ id: string, title: string, artist: string, durationMs: number, trackNumber: number, coverUrl: string|null }> }>}
   */
  async getAlbum(id) {
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
   * Get playlist information and its track list.
   * @param {string} id
   * @returns {Promise<{ id: string, title: string, curator: string, coverUrl: string|null, totalTracks: number, tracks: Array<{ id: string, title: string, artist: string, durationMs: number, trackNumber: number, coverUrl: string|null }> }>}
   */
  async getPlaylist(id) {
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
        coverUrl: null, // Individual track album art will be resolved on download
        playlistCoverUrl: coverUrl // Fallback in case individual resolution fails
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
}

const instance = new SpotifyService();
instance.SpotifyService = SpotifyService;
module.exports = instance;
