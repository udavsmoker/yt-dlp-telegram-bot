const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const util = require('util');
const axios = require('axios');
const execFileAsync = util.promisify(execFile);
const youtubedlExec = require('youtube-dl-exec');
const config = require('../config');
const logger = require('../utils/logger');
const { generateFilename, cleanupFile, prepareThumbnail, getYtdlpPath } = require('../utils/helpers');

const youtubedl = youtubedlExec.create(getYtdlpPath());

class SpotifyAudioService {
  /**
   * Normalize text for fuzzy matching.
   */
  normalizeText(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9а-яё]/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Score a YouTube search candidate against the Spotify track metadata.
   */
  scoreCandidate(candidate, track) {
    const normCandTitle = this.normalizeText(candidate.title);
    const normTargetTitle = this.normalizeText(track.title);
    const normCandUploader = this.normalizeText(candidate.uploader);
    const normTargetArtist = this.normalizeText(track.artist);
    const mainArtist = this.normalizeText(track.artists?.[0] || track.artist);

    let score = 0;

    // 1. Topic channel / artist scoring (official YouTube Music audio)
    const isTopic = candidate.uploader && candidate.uploader.endsWith('- Topic');
    if (isTopic) {
      score += 45;
      if (
        normCandUploader.includes(normTargetArtist) ||
        normTargetArtist.includes(normCandUploader.replace('topic', '').trim()) ||
        normCandUploader.includes(mainArtist) ||
        mainArtist.includes(normCandUploader.replace('topic', '').trim())
      ) {
        score += 35;
      }
    } else if (
      normCandUploader.includes(normTargetArtist) ||
      normTargetArtist.includes(normCandUploader) ||
      normCandUploader.includes(mainArtist)
    ) {
      score += 30;
    }

    // 2. Title matching
    if (normCandTitle === normTargetTitle) {
      score += 50; // Exact title match
    } else if (normCandTitle.includes(normTargetTitle)) {
      score += 30;
    } else {
      const targetWords = normTargetTitle.split(' ').filter(w => w.length > 2);
      const matchedWords = targetWords.filter(w => normCandTitle.includes(w));
      if (targetWords.length > 0) {
        score += Math.round((matchedWords.length / targetWords.length) * 25);
      }
    }

    // 3. Penalize unwanted keywords unless present in original track title
    const badWords = [
      'remix', 'cover', 'live', 'sped up', 'slowed', 'loop',
      'bass boosted', 'instrumental', 'karaoke', 'parody', 'tribute',
      'reaction', 'tutorial', 'guitar', 'piano'
    ];
    for (const bw of badWords) {
      if (normCandTitle.includes(bw) && !normTargetTitle.includes(bw)) {
        score -= 35;
      }
    }

    // 4. Duration comparison (matches studio length against Spotify durationMs)
    if (track.durationMs && candidate.duration > 0) {
      const targetSec = Math.round(track.durationMs / 1000);
      const diff = Math.abs(candidate.duration - targetSec);

      if (diff <= 2) {
        score += 45; // Precise studio length match
      } else if (diff <= 5) {
        score += 30;
      } else if (diff <= 12) {
        score += 15;
      } else if (diff > 30) {
        score -= 40; // Likely a full album, live gig, or wrong song
      }
    }

    return score;
  }

  /**
   * Search YouTube Music Innertube API (WEB_REMIX) for track candidates.
   * Extremely fast (300-500ms) and avoids yt-dlp Python initialization.
   * @param {string} query
   * @param {object} [options={}]
   * @returns {Promise<Array<{ id: string, title: string, uploader: string, duration: number }>>}
   */
  async searchInnertube(query, options = {}) {
    const cleanQuery = (query || '').replace(/['"“”«»]/g, '').trim();
    if (!cleanQuery) return [];

    try {
      const res = await axios.post('https://music.youtube.com/youtubei/v1/search', {
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20261028.01.00',
            hl: 'en',
            gl: 'US'
          }
        },
        query: cleanQuery
      }, {
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 8000,
        signal: options.signal
      });

      const candidates = [];
      const addCandidate = (id, title, uploader, durText) => {
        if (!id || id.length !== 11) return;
        if (candidates.some(c => c.id === id)) return;
        let duration = 0;
        if (durText) {
          const parts = durText.split(':').map(p => parseInt(p, 10));
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            duration = parts[0] * 60 + parts[1];
          } else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
            duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
          }
        }
        candidates.push({ id, title: title || '', uploader: uploader || '', duration });
      };

      const parseRenderer = (r) => {
        if (!r) return;
        const flexCols = r.flexColumns || [];
        const title = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join('');
        const subRuns = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const subText = subRuns.map(x => x.text).join('');
        const uploader = subRuns.find(x => x.navigationEndpoint?.browseEndpoint)?.text || subRuns[0]?.text || subText;
        let durText = '';
        const lastRun = subRuns[subRuns.length - 1]?.text;
        if (lastRun && /^\d+:\d+(?::\d+)?$/.test(lastRun.trim())) durText = lastRun.trim();
        const fixedCols = r.fixedColumns || [];
        const fixedDur = fixedCols[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text;
        if (fixedDur && /^\d+:\d+(?::\d+)?$/.test(fixedDur.trim())) durText = fixedDur.trim();

        const vid = r.playlistItemData?.videoId ||
          flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
          r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;

        if (vid) addCandidate(vid, title, uploader, durText);
      };

      const sec = res.data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const s of sec) {
        if (s.musicCardShelfRenderer) {
          const card = s.musicCardShelfRenderer;
          const vid = card.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
            card.buttons?.[0]?.buttonRenderer?.command?.watchEndpoint?.videoId;
          const title = card.title?.runs?.map(x => x.text).join('');
          const subRuns = card.subtitle?.runs || [];
          const uploader = subRuns.find(r => r.navigationEndpoint?.browseEndpoint)?.text || subRuns[0]?.text || '';
          const lastRun = subRuns[subRuns.length - 1]?.text;
          let durText = '';
          if (lastRun && /^\d+:\d+(?::\d+)?$/.test(lastRun.trim())) durText = lastRun.trim();
          if (vid) addCandidate(vid, title, uploader, durText);
        }
        if (s.musicShelfRenderer) {
          for (const item of s.musicShelfRenderer.contents || []) parseRenderer(item.musicResponsiveListItemRenderer);
        }
        if (s.itemSectionRenderer) {
          for (const item of s.itemSectionRenderer.contents || []) parseRenderer(item.musicResponsiveListItemRenderer);
        }
      }

      return candidates;
    } catch (err) {
      if (options.signal?.aborted || err.name === 'AbortError') {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      logger.warn(`Innertube search failed for "${query}": ${err.message}`);
      return [];
    }
  }

  /**
   * Search YouTube candidates using yt-dlp flat playlist as fallback.
   */
  async searchYtdlpCandidates(query, options = {}) {
    const cleanQuery = (query || '').replace(/['"“”«»]/g, '').trim();
    const ytdlpPath = process.env.YTDLP_PATH || '/home/udav/.local/bin/yt-dlp';

    try {
      const { stdout } = await execFileAsync(ytdlpPath, [
        '--flat-playlist',
        '--print', '%(id)s\t%(title)s\t%(uploader)s\t%(duration)s',
        `ytsearch8:${cleanQuery}`
      ], {
        signal: options.signal,
        timeout: 15000
      });

      const lines = stdout.trim().split('\n').filter(Boolean);
      const candidates = [];
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const id = parts[0].trim();
          const title = parts[1].trim();
          const uploader = parts[2] ? parts[2].trim() : '';
          const duration = parts[3] ? parseFloat(parts[3]) : 0;
          candidates.push({ id, title, uploader, duration });
        }
      }
      return candidates;
    } catch (err) {
      if (options.signal?.aborted || err.name === 'AbortError') {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      logger.warn(`yt-dlp candidate search failed for "${query}": ${err.message}`);
      return [];
    }
  }

  /**
   * Find and score top YouTube candidates for a track.
   * Returns array of candidates sorted by match score descending.
   * @param {object} track
   * @param {object} [options={}]
   * @returns {Promise<Array<{ id: string, title: string, uploader: string, duration: number, score: number }>>}
   */
  async findCandidates(track, options = {}) {
    const cleanArtist = (track.artist || '').replace(/['"“”«»]/g, '').trim();
    const cleanTitle = (track.title || '').replace(/['"“”«»]/g, '').trim();
    const fullQuery = `${cleanArtist} ${cleanTitle}`.trim();

    let candidates = await this.searchInnertube(fullQuery, options);

    // If query by artist+title returned fewer than 2 candidates, try title alone
    if (candidates.length < 2 && cleanTitle) {
      const titleCandidates = await this.searchInnertube(cleanTitle, options);
      for (const tc of titleCandidates) {
        if (!candidates.some(c => c.id === tc.id)) {
          candidates.push(tc);
        }
      }
    }

    // Fallback to yt-dlp if Innertube returned nothing
    if (candidates.length === 0) {
      candidates = await this.searchYtdlpCandidates(fullQuery, options);
    }

    if (candidates.length === 0) {
      return [];
    }

    // Score and rank candidates
    const scored = candidates.map(cand => ({
      ...cand,
      score: this.scoreCandidate(cand, track)
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Search YouTube for top candidates and pick the best match based on artist, title, and duration.
   */
  async findBestYouTubeMatch(track, options = {}) {
    try {
      const candidates = await this.findCandidates(track, options);
      if (candidates.length === 0) return null;
      const best = candidates[0];
      logger.info(`Best YouTube match for "${track.title}" by "${track.artist}": "${best.title}" by "${best.uploader}" (${best.duration}s, id: ${best.id}, score: ${best.score})`);
      return best;
    } catch (err) {
      if (options.signal?.aborted || err.name === 'AbortError') {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      logger.warn(`Failed to find candidate list for "${track.title}": ${err.message}.`);
      return null;
    }
  }

  /**
   * Search YouTube directly for audio tracks matching a query.
   * @param {string} query
   * @param {number} [limit=5]
   * @param {object} [options={}]
   * @returns {Promise<Array<object>>}
   */
  async searchYouTubeTracks(query, limit = 5, options = {}) {
    const cleanQuery = (query || '').replace(/['"“”«»]/g, '').trim();
    if (!cleanQuery) return [];

    try {
      // 1. Try fast Innertube search first
      const innertubeResults = await this.searchInnertube(cleanQuery, options);
      if (innertubeResults.length > 0) {
        return innertubeResults.slice(0, limit).map(item => ({
          id: `yt_${item.id}`,
          youtubeId: item.id,
          title: item.title,
          artist: item.uploader || 'YouTube',
          artists: [item.uploader || 'YouTube'],
          album: item.title,
          durationMs: item.duration > 0 ? Math.round(item.duration * 1000) : 0,
          coverUrl: null,
          releaseDate: null
        }));
      }

      // 2. Fallback to yt-dlp search if Innertube returned nothing
      const ytdlpCandidates = await this.searchYtdlpCandidates(cleanQuery, options);
      return ytdlpCandidates.slice(0, limit).map(item => ({
        id: `yt_${item.id}`,
        youtubeId: item.id,
        title: item.title,
        artist: item.uploader || 'YouTube',
        artists: [item.uploader || 'YouTube'],
        album: item.title,
        durationMs: item.duration > 0 ? Math.round(item.duration * 1000) : 0,
        coverUrl: null,
        releaseDate: null
      }));
    } catch (err) {
      if (options.signal?.aborted || err.name === 'AbortError') {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      logger.warn(`YouTube search failed for "${query}": ${err.message}`);
      return [];
    }
  }

  /**
   * Search, download, tag, and prepare a Spotify track as a high-quality MP3.
   * @param {object} track - { id, title, artist, album, durationMs, coverUrl, trackNumber, releaseDate }
   * @param {object} options - { signal, onProgress }
   * @returns {Promise<{ audioPath: string, thumbnailPath: string|null, title: string, artist: string, duration: number, cleanup: Function }>}
   */
  async downloadAndTagTrack(track, options = {}) {
    const rawFilename = generateFilename(`spotify_raw_${track.id}`, 'm4a');
    const rawAudioPath = path.join(config.download.tempDir, rawFilename);
    const finalFilename = generateFilename(`spotify_${track.id}`, 'mp3');
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

      // 1. Download cover art if available
      if (track.coverUrl) {
        try {
          const coverFilename = generateFilename(`spotify_cover_${track.id}`, 'jpg');
          coverPath = path.join(config.download.tempDir, coverFilename);
          const res = await axios.get(track.coverUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            signal: options.signal
          });
          await fs.writeFile(coverPath, res.data);
          preparedThumbPath = await prepareThumbnail(coverPath);
        } catch (err) {
          logger.warn(`Failed to download cover art for ${track.title}: ${err.message}`);
          coverPath = null;
          preparedThumbPath = null;
        }
      }

      if (options.signal?.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }

      // 2. Resolve candidates and download raw audio stream with multi-candidate fallback
      logger.info(`Searching audio for Spotify track "${track.title}" by "${track.artist}"`);
      const candidates = track.youtubeId
        ? [{ id: track.youtubeId, title: track.title, uploader: track.artist, score: 100 }]
        : await this.findCandidates(track, options);

      const targetsToTry = candidates.length > 0
        ? candidates.slice(0, 3).map(c => `https://www.youtube.com/watch?v=${c.id}`)
        : [`ytsearch1:${(track.artist || '').replace(/['"“”«»]/g, '')} ${(track.title || '').replace(/['"“”«»]/g, '')}`];

      let downloadSuccess = false;
      let lastDownloadError = null;

      for (const downloadTarget of targetsToTry) {
        if (options.signal?.aborted) {
          throw new Error('DOWNLOAD_CANCELLED');
        }

        const ytdlpFlags = {
          format: 'bestaudio[ext=m4a]/bestaudio/best',
          output: rawAudioPath,
          noPlaylist: true,
          newline: true,
          progress: true,
          progressTemplate: 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s'
        };

        try {
          const proc = youtubedl.exec(downloadTarget, ytdlpFlags, options.signal ? { signal: options.signal } : {});

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

          // Verify raw audio file was created and is non-empty
          await fs.access(rawAudioPath);
          const stat = await fs.stat(rawAudioPath);
          if (stat.size > 1000) {
            downloadSuccess = true;
            break;
          } else {
            await cleanupFile(rawAudioPath);
          }
        } catch (targetErr) {
          await cleanupFile(rawAudioPath);
          if (options.signal?.aborted || targetErr.name === 'AbortError' || targetErr.code === 'ERR_ABORTED') {
            throw new Error('DOWNLOAD_CANCELLED');
          }
          lastDownloadError = targetErr;
          logger.warn(`Failed downloading candidate ${downloadTarget} for "${track.title}": ${targetErr.message}. Trying next candidate...`);
        }
      }

      if (!downloadSuccess) {
        throw lastDownloadError || new Error(`No available audio streams found for "${track.title}"`);
      }

      if (options.signal?.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }

      // 3. Encode to pristine 320 kbps MP3 with embedded ID3v2.3 tags and cover art
      logger.info(`Transcoding "${track.title}" to 320k MP3 with embedded ID3v2.3 metadata`);

      const ffmpegArgs = ['-y', '-i', rawAudioPath];

      if (coverPath) {
        ffmpegArgs.push('-i', coverPath, '-map', '0:a', '-map', '1:v');
        ffmpegArgs.push('-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
      } else {
        ffmpegArgs.push('-map', '0:a');
      }

      ffmpegArgs.push(
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-id3v2_version', '3',
        '-metadata', `title=${track.title}`,
        '-metadata', `artist=${track.artist}`,
        '-metadata', `album=${track.album || track.title}`
      );

      if (track.releaseDate) {
        const year = track.releaseDate.substring(0, 4);
        ffmpegArgs.push('-metadata', `date=${year}`);
      }

      if (track.trackNumber) {
        ffmpegArgs.push('-metadata', `track=${track.trackNumber}`);
      }

      ffmpegArgs.push(finalAudioPath);

      await execFileAsync('ffmpeg', ffmpegArgs, {
        signal: options.signal,
        timeout: 60000
      });

      // Verify final file
      await fs.access(finalAudioPath);

      // Clean up the raw download stream early
      await cleanupFile(rawAudioPath);

      const durationSec = track.durationMs ? Math.round(track.durationMs / 1000) : undefined;

      return {
        audioPath: finalAudioPath,
        thumbnailPath: preparedThumbPath,
        title: track.title,
        artist: track.artist,
        duration: durationSec,
        cleanup
      };
    } catch (error) {
      await cleanup();
      if (options.signal?.aborted || error.name === 'AbortError' || error.code === 'ERR_ABORTED') {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      throw error;
    }
  }
}

const instance = new SpotifyAudioService();
instance.SpotifyAudioService = SpotifyAudioService;
module.exports = instance;
