const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const util = require('util');
const axios = require('axios');
const execFileAsync = util.promisify(execFile);
const youtubedlExec = require('youtube-dl-exec');
const config = require('../config');
const logger = require('../utils/logger');
const { generateFilename, cleanupFile, prepareThumbnail } = require('../utils/helpers');

const youtubedl = youtubedlExec.create(process.env.YTDLP_PATH || '/home/udav/.local/bin/yt-dlp');

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
   * Search YouTube for top candidates and pick the best match based on artist, title, and duration.
   */
  async findBestYouTubeMatch(track, options = {}) {
    const cleanArtist = (track.artist || '').replace(/['"“”«»]/g, '').trim();
    const cleanTitle = (track.title || '').replace(/['"“”«»]/g, '').trim();
    const query = `ytsearch8:${cleanArtist} ${cleanTitle}`;

    const ytdlpPath = process.env.YTDLP_PATH || '/home/udav/.local/bin/yt-dlp';

    try {
      const { stdout } = await execFileAsync(ytdlpPath, [
        '--flat-playlist',
        '--print', '%(id)s\t%(title)s\t%(uploader)s\t%(duration)s',
        query
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

      if (candidates.length === 0) {
        return null;
      }

      let best = candidates[0];
      let bestScore = -Infinity;

      for (const cand of candidates) {
        const score = this.scoreCandidate(cand, track);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }

      logger.info(`Best YouTube match for "${track.title}" by "${track.artist}": "${best.title}" by "${best.uploader}" (${best.duration}s, id: ${best.id}, score: ${bestScore})`);
      return best;
    } catch (err) {
      if (options.signal?.aborted || err.name === 'AbortError') {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      logger.warn(`Failed to find candidate list for "${track.title}": ${err.message}. Falling back to direct search.`);
      return null;
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

      // 2. Resolve best YouTube audio stream
      logger.info(`Searching audio for Spotify track "${track.title}" by "${track.artist}"`);
      const bestMatch = await this.findBestYouTubeMatch(track, options);

      const downloadTarget = bestMatch?.id
        ? `https://www.youtube.com/watch?v=${bestMatch.id}`
        : `ytsearch1:${(track.artist || '').replace(/['"“”«»]/g, '')} ${(track.title || '').replace(/['"“”«»]/g, '')}`;

      const ytdlpFlags = {
        format: 'bestaudio[ext=m4a]/bestaudio/best',
        output: rawAudioPath,
        noPlaylist: true,
        newline: true,
        progress: true,
        progressTemplate: 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s'
      };

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

      // Verify raw audio file was created
      await fs.access(rawAudioPath);

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
