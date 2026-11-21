const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const util = require('util');
const axios = require('axios');
const execFileAsync = util.promisify(execFile);
const youtubedlExec = require('youtube-dl-exec');
const config = require('../config');
const logger = require('../utils/logger');
const {
  generateFilename,
  cleanupFile,
  prepareThumbnail,
  getYtdlpPath,
  ensureDir
} = require('../utils/helpers');

const youtubedl = youtubedlExec.create(getYtdlpPath());

class SoundCloudService {
  /**
   * Check if the given URL is a valid SoundCloud URL.
   * Supports soundcloud.com, m.soundcloud.com, on.soundcloud.com and subdomains.
   * @param {string} url
   * @returns {boolean}
   */
  isSoundCloudUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url.trim());
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const isScDomain = (
        hostname === 'soundcloud.com' ||
        hostname === 'm.soundcloud.com' ||
        hostname === 'on.soundcloud.com' ||
        hostname.endsWith('.soundcloud.com')
      );
      if (!isScDomain) return false;

      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 0) return false;

      // Filter out reserved platform pages
      const reserved = [
        'discover', 'stream', 'upload', 'search', 'terms-of-use',
        'privacy', 'settings', 'notifications', 'imprint', 'popular'
      ];
      if (parts.length === 1 && reserved.includes(parts[0].toLowerCase())) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse a SoundCloud URL to identify its type and constituent segments.
   * @param {string} url
   * @returns {{ type: 'track'|'set'|'shortlink'|'unknown', artist?: string, slug?: string, url: string }|null}
   */
  parseUrl(url) {
    if (!this.isSoundCloudUrl(url)) return null;
    try {
      const parsed = new URL(url.trim());
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const parts = parsed.pathname.split('/').filter(Boolean);

      if (hostname === 'on.soundcloud.com') {
        return { type: 'shortlink', url };
      }

      if (parts.length >= 3 && parts[1].toLowerCase() === 'sets') {
        return {
          type: 'set',
          artist: parts[0],
          slug: parts[2],
          url
        };
      }

      if (parts.length >= 2) {
        return {
          type: 'track',
          artist: parts[0],
          slug: parts[1],
          url
        };
      }

      return { type: 'unknown', url };
    } catch {
      return null;
    }
  }

  getEntryThumbnail(entry) {
    if (entry.thumbnail) return entry.thumbnail;
    if (!Array.isArray(entry.thumbnails)) return null;

    const thumbnails = entry.thumbnails
      .filter(item => item && typeof item.url === 'string')
      .sort((a, b) => {
        const areaA = (Number(a.width) || 0) * (Number(a.height) || 0);
        const areaB = (Number(b.width) || 0) * (Number(b.height) || 0);
        return areaB - areaA;
      });
    return thumbnails[0]?.url || null;
  }

  normalizePlaylistTrack(entry, fallbackSet, index) {
    const trackUrl = entry.webpage_url ||
      entry.url ||
      (entry.id ? `https://api.soundcloud.com/tracks/${entry.id}` : null);
    const title = typeof entry.title === 'string' && entry.title.trim()
      ? entry.title.trim()
      : `Track ${index + 1}`;
    const artist = entry.uploader ||
      entry.artist ||
      entry.creator ||
      fallbackSet.uploader ||
      fallbackSet.artist ||
      'SoundCloud Artist';

    return {
      index: index + 1,
      id: String(entry.id || `sc_${index + 1}`),
      title,
      artist,
      album: entry.album || fallbackSet.title || 'SoundCloud Set',
      duration: typeof entry.duration === 'number' ? entry.duration : 0,
      url: trackUrl,
      thumbnail: this.getEntryThumbnail(entry)
    };
  }

  async resolvePlaylistTracks(entries, fallbackSet, options = {}) {
    const initialTracks = entries.map((entry, index) =>
      this.normalizePlaylistTrack(entry, fallbackSet, index)
    );

    const concurrency = 4;
    let cursor = 0;

    const resolveOne = async (trackIndex) => {
      if (options.signal?.aborted) throw new Error('DOWNLOAD_CANCELLED');

      const entry = entries[trackIndex];
      const track = initialTracks[trackIndex];
      const needsResolution = !entry.title ||
        /^(?:Track\s+\d+|.+(?:-|\]\s*)\s*Track\s+\d+)$/i.test(track.title) ||
        !track.artist ||
        track.artist === 'SoundCloud Artist' ||
        !track.thumbnail ||
        !track.duration;

      if (!needsResolution || !track.url) return track;

      try {
        const resolved = await this.getMetadata(track.url, options);
        if (resolved.type !== 'track') return track;

        return {
          ...track,
          id: resolved.id || track.id,
          title: resolved.title || track.title,
          artist: resolved.artist || track.artist,
          album: resolved.album || track.album,
          duration: resolved.duration || track.duration,
          url: resolved.url || track.url,
          thumbnail: resolved.thumbnail || track.thumbnail
        };
      } catch (err) {
        if (options.signal?.aborted) throw new Error('DOWNLOAD_CANCELLED');
        logger.warn(`Could not resolve SoundCloud playlist track #${trackIndex + 1}: ${err.message}`);
        return track;
      }
    };

    const worker = async () => {
      while (cursor < initialTracks.length) {
        const trackIndex = cursor++;
        initialTracks[trackIndex] = await resolveOne(trackIndex);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, initialTracks.length) }, () => worker())
    );

    return initialTracks;
  }

  /**
   * Extract comprehensive metadata for a SoundCloud track or set directly via yt-dlp.
   * @param {string} url
   * @param {object} [options={}] - { signal }
   * @returns {Promise<object>}
   */
  async getMetadata(url, options = {}) {
    if (options.signal?.aborted) {
      throw new Error('DOWNLOAD_CANCELLED');
    }

    try {
      logger.info(`Fetching SoundCloud metadata: ${url}`);
      const raw = await youtubedl(url, {
        dumpSingleJson: true
      }, options.signal ? { signal: options.signal } : {});

      if (!raw) {
        throw new Error('SoundCloud returned empty metadata');
      }

      const isPlaylist = raw._type === 'playlist' || (Array.isArray(raw.entries) && raw.entries.length > 0);

      if (isPlaylist) {
        const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
        const tracks = await this.resolvePlaylistTracks(rawEntries, raw, options);

        return {
          type: 'set',
          id: String(raw.id || 'soundcloud_set'),
          title: raw.title || 'SoundCloud Set',
          artist: raw.uploader || raw.artist || 'SoundCloud Artist',
          trackCount: tracks.length,
          thumbnail: raw.thumbnail || null,
          url: raw.webpage_url || url,
          tracks
        };
      }

      return {
        type: 'track',
        id: String(raw.id || 'soundcloud_track'),
        title: raw.title || raw.track || 'SoundCloud Track',
        artist: raw.artist || raw.uploader || 'SoundCloud Artist',
        album: raw.album || raw.title || 'SoundCloud Track',
        duration: typeof raw.duration === 'number' ? raw.duration : 0,
        thumbnail: raw.thumbnail || null,
        url: raw.webpage_url || url
      };
    } catch (err) {
      if (options.signal?.aborted || err.name === 'AbortError' || err.code === 'ERR_ABORTED') {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      logger.error(`Failed to get SoundCloud metadata for ${url}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Download audio directly from SoundCloud, transcode to 320 kbps MP3,
   * embed ID3v2.3 metadata and artwork, and prepare Telegram-compliant thumbnail.
   *
   * @param {object|string} trackOrUrl - Metadata object or direct track URL
   * @param {object} [options={}] - { signal, onProgress }
   * @returns {Promise<{
   *   audioPath: string,
   *   thumbnailPath: string|null,
   *   title: string,
   *   artist: string,
   *   duration: number,
   *   fileSize: number,
   *   cleanup: Function
   * }>}
   */
  async downloadAndTagTrack(trackOrUrl, options = {}) {
    await ensureDir(config.download.tempDir);

    const targetUrl = typeof trackOrUrl === 'string'
      ? trackOrUrl
      : (trackOrUrl.url || trackOrUrl.webpage_url);

    if (!targetUrl) {
      throw new Error('Missing SoundCloud track URL');
    }

    let meta = typeof trackOrUrl === 'object' && trackOrUrl.title
      ? trackOrUrl
      : null;

    if (!meta) {
      meta = await this.getMetadata(targetUrl, options);
    }
    else if (
      targetUrl &&
      (/^Track\s+\d+$/i.test(meta.title) ||
        /(?:-|\]\s*)\s*Track\s+\d+\s*$/i.test(meta.title) ||
        !meta.artist ||
        meta.artist === 'SoundCloud Artist' ||
        !meta.thumbnail ||
        meta.album === 'SoundCloud Set')
    ) {
      try {
        const resolved = await this.getMetadata(targetUrl, options);
        if (resolved.type === 'track') {
          meta = {
            ...meta,
            id: resolved.id || meta.id,
            title: resolved.title || meta.title,
            artist: resolved.artist || meta.artist,
            album: resolved.album || meta.album,
            duration: resolved.duration || meta.duration,
            thumbnail: resolved.thumbnail || meta.thumbnail,
            url: resolved.url || targetUrl
          };
        }
      } catch (err) {
        if (options.signal?.aborted) throw new Error('DOWNLOAD_CANCELLED');
        logger.warn(`Could not enrich SoundCloud track metadata for "${meta.title}": ${err.message}`);
      }
    }

    const safeId = (meta.id || Date.now()).toString().replace(/[^a-zA-Z0-9_-]/g, '_');
    const rawFilename = generateFilename(`sc_raw_${safeId}`, 'm4a');
    const rawAudioPath = path.join(config.download.tempDir, rawFilename);
    const finalFilename = generateFilename(`sc_${safeId}`, 'mp3');
    const finalAudioPath = path.join(config.download.tempDir, finalFilename);

    let coverPath = null;
    let preparedThumbPath = null;

    const cleanup = async () => {
      await cleanupFile(rawAudioPath);
      await cleanupFile(finalAudioPath);
      if (coverPath) await cleanupFile(coverPath);
      if (preparedThumbPath) await cleanupFile(preparedThumbPath);
    };

    try {
      if (options.signal?.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }

      // 1. Download artwork if available
      if (meta.thumbnail) {
        try {
          const coverFilename = generateFilename(`sc_cover_${safeId}`, 'jpg');
          coverPath = path.join(config.download.tempDir, coverFilename);
          const res = await axios.get(meta.thumbnail, {
            responseType: 'arraybuffer',
            timeout: 15000,
            signal: options.signal
          });
          await fs.writeFile(coverPath, res.data);
          preparedThumbPath = await prepareThumbnail(coverPath);
        } catch (err) {
          if (options.signal?.aborted) throw new Error('DOWNLOAD_CANCELLED');
          logger.warn(`Failed to fetch SoundCloud artwork for "${meta.title}": ${err.message}`);
          coverPath = null;
          preparedThumbPath = null;
        }
      }

      if (options.signal?.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }

      // 2. Download audio stream directly from SoundCloud via yt-dlp
      logger.info(`Starting SoundCloud direct audio download: "${meta.title}" by ${meta.artist}`);

      const ytdlpFlags = {
        format: 'bestaudio/best',
        output: rawAudioPath,
        noPlaylist: true,
        newline: true,
        progress: true,
        progressTemplate: 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s'
      };

      const proc = youtubedl.exec(targetUrl, ytdlpFlags, options.signal ? { signal: options.signal } : {});

      if (options.onProgress && proc.stdout) {
        proc.stdout.on('data', chunk => {
          const text = chunk.toString();
          const m = text.match(/(?:download:)?\s*(\d+\.?\d*)%\|\s*([^|]+)\|\s*([^\r\n]+)/);
          if (m) {
            options.onProgress({
              percent: parseFloat(m[1]),
              speed: m[2].trim(),
              eta: m[3].trim()
            });
          }
        });
      }

      await proc;

      // Verify raw audio file was created
      await fs.access(rawAudioPath);
      const rawStat = await fs.stat(rawAudioPath);
      if (rawStat.size < 1000) {
        throw new Error('Downloaded audio stream is corrupted or empty');
      }

      if (options.signal?.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }

      // 3. Transcode to pristine 320 kbps MP3 with embedded ID3v2.3 tags and cover art
      logger.info(`Transcoding "${meta.title}" to 320k MP3 with embedded ID3v2.3 metadata`);

      const ffmpegArgs = ['-y', '-i', rawAudioPath];

      if (coverPath) {
        ffmpegArgs.push('-i', coverPath, '-map', '0:a', '-map', '1:v');
        ffmpegArgs.push('-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
      } else {
        ffmpegArgs.push('-map', '0:a');
      }

      const cleanTitle = (meta.title || 'SoundCloud Track').replace(/[\r\n\t]/g, ' ').trim();
      const cleanArtist = (meta.artist || 'SoundCloud Artist').replace(/[\r\n\t]/g, ' ').trim();
      const cleanAlbum = (meta.album || cleanTitle).replace(/[\r\n\t]/g, ' ').trim();

      ffmpegArgs.push(
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-ar', '44100',
        '-id3v2_version', '3',
        '-metadata', `title=${cleanTitle}`,
        '-metadata', `artist=${cleanArtist}`,
        '-metadata', `album=${cleanAlbum}`
      );

      ffmpegArgs.push(finalAudioPath);

      await execFileAsync('ffmpeg', ffmpegArgs, {
        signal: options.signal,
        timeout: 60000
      });

      // Verify final MP3
      await fs.access(finalAudioPath);
      const finalStat = await fs.stat(finalAudioPath);

      // Clean up raw stream early
      await cleanupFile(rawAudioPath);

      const durationSec = typeof meta.duration === 'number'
        ? Math.round(meta.duration)
        : 0;

      return {
        audioPath: finalAudioPath,
        thumbnailPath: preparedThumbPath,
        title: cleanTitle,
        artist: cleanArtist,
        duration: durationSec,
        fileSize: finalStat.size,
        cleanup
      };
    } catch (err) {
      await cleanup();
      if (options.signal?.aborted || err.name === 'AbortError' || err.code === 'ERR_ABORTED') {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      throw err;
    }
  }
}

const instance = new SoundCloudService();
instance.SoundCloudService = SoundCloudService;
module.exports = instance;

