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

      // 2. Search and download best audio stream via yt-dlp
      const searchQuery = `ytsearch1:${track.artist} - ${track.title} Official Audio`;
      logger.info(`Searching audio for Spotify track "${track.title}" by "${track.artist}"`);

      const ytdlpFlags = {
        format: 'bestaudio[ext=m4a]/bestaudio/best',
        output: rawAudioPath,
        noPlaylist: true,
        newline: true,
        progress: true,
        progressTemplate: 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s'
      };

      const proc = youtubedl.exec(searchQuery, ytdlpFlags, options.signal ? { signal: options.signal } : {});

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
