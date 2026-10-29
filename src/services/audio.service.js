const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const path = require('path');
const fs = require('fs').promises;
const { generateFilename, ensureDir } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');

class AudioService {
  /**
   * Convert a video file to MP3 audio
   * @param {string} videoPath - absolute path to the video file
   * @param {string|null} [thumbPath=null]
   * @param {object} [options={}] - { signal }
   * @returns {Promise<{audioPath: string, duration: number, title: string, artist: string, fileSize: number}>}
   */
  async convertToMp3(videoPath, thumbPath = null, options = {}) {
    await ensureDir(config.download.tempDir);
    const signal = options.signal;
    
    const audioFilename = generateFilename('audio', 'mp3');
    const audioPath = path.join(config.download.tempDir, audioFilename);
    
    try {
      // Extract audio metadata first
      let duration = 0;
      let title = 'Audio';
      let artist = 'Unknown';
      
      try {
        const { stdout: metadata } = await execFile('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration:format_tags=title,artist,author',
          '-of', 'json',
          videoPath
        ], { encoding: 'utf8', timeout: 10000, signal });
        const parsed = JSON.parse(metadata);
        if (parsed.format) {
          duration = parseFloat(parsed.format.duration) || 0;
          if (parsed.format.tags) {
            title = parsed.format.tags.title || 'Audio';
            artist = parsed.format.tags.artist || parsed.format.tags.author || 'Unknown';
          }
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        logger.warn(`Could not get audio metadata: ${e.message}`);
      }
      
      // Convert to MP3
      let extractedThumb = null;
      if (!thumbPath) {
        const tempThumb = path.join(config.download.tempDir, `extracted_thumb_${Date.now()}.jpg`);
        try {
          // Try to extract the first frame
          await execFile('ffmpeg', [
            '-y',
            '-i', videoPath,
            '-frames:v', '1',
            '-q:v', '2',
            tempThumb
          ], { timeout: 15000, signal });
          if (require('fs').existsSync(tempThumb)) {
            thumbPath = tempThumb;
            extractedThumb = tempThumb;
          }
        } catch (e) {
          if (signal?.aborted) throw e;
          // Ignore errors, we'll just convert without thumbnail
        }
      }

      try {
        if (thumbPath) {
          await execFile('ffmpeg', [
            '-y',
            '-i', videoPath,
            '-i', thumbPath,
            '-map', '0:a:0?',
            '-map', '1:v:0',
            '-c:a', 'libmp3lame',
            '-b:a', '320k',
            '-ar', '44100',
            '-c:v', 'copy',
            '-id3v2_version', '3',
            '-metadata:s:v', 'title=Album cover',
            '-metadata:s:v', 'comment=Cover (front)',
            audioPath
          ], { timeout: 120000, signal });
        } else {
          await execFile('ffmpeg', [
            '-y',
            '-i', videoPath,
            '-map', '0:a:0?',
            '-vn',
            '-c:a', 'libmp3lame',
            '-b:a', '320k',
            '-ar', '44100',
            audioPath
          ], { timeout: 120000, signal });
        }
      } finally {
        if (extractedThumb) {
          try { await fs.unlink(extractedThumb); } catch {}
        }
      }
      
      // Verify the file was created
      const stats = await fs.stat(audioPath);
      if (stats.size === 0) {
        throw new Error('Converted audio file is empty');
      }
      
      logger.info(`Audio converted: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
      
      return {
        audioPath,
        duration: Math.floor(duration),
        title,
        artist,
        fileSize: stats.size
      };
    } catch (error) {
      // Cleanup on failure
      try { await fs.unlink(audioPath); } catch {}
      throw new Error(`Audio conversion failed: ${error.message}`);
    }
  }

  /**
   * Probe audio metadata using ffprobe.
   * @param {string} filePath
   * @param {AbortSignal|null} [signal=null]
   * @returns {Promise<{duration: number, title: string, artist: string}>}
   */
  async probeAudio(filePath, signal = null) {
    let duration = 0;
    let title = 'Audio';
    let artist = 'Unknown';
    try {
      const { stdout: metadata } = await execFile('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:format_tags=title,artist,author,album',
        '-of', 'json',
        filePath
      ], { encoding: 'utf8', timeout: 10000, signal });
      const parsed = JSON.parse(metadata);
      if (parsed.format) {
        duration = parseFloat(parsed.format.duration) || 0;
        if (parsed.format.tags) {
          title = parsed.format.tags.title || 'Audio';
          artist = parsed.format.tags.artist || parsed.format.tags.author || 'Unknown';
        }
      }
    } catch {}
    return { duration, title, artist };
  }

  /**
   * Edit ID3 tags and cover art of an audio file without re-encoding audio frames.
   * @param {string} inputAudioPath
   * @param {object} tags - { title, artist, album, coverPath }
   * @param {object} [options={}] - { signal }
   * @returns {Promise<{audioPath: string, duration: number, title: string, artist: string, fileSize: number}>}
   */
  async editAudioTags(inputAudioPath, tags = {}, options = {}) {
    await ensureDir(config.download.tempDir);
    const signal = options.signal;
    const outputFilename = generateFilename('tagged_audio', 'mp3');
    const outputAudioPath = path.join(config.download.tempDir, outputFilename);

    try {
      const existing = await this.probeAudio(inputAudioPath, signal);
      const newTitle = tags.title?.trim() || existing.title;
      const newArtist = tags.artist?.trim() || existing.artist;
      const newAlbum = tags.album?.trim() || newTitle;

      const ffmpegArgs = ['-y', '-i', inputAudioPath];

      if (tags.coverPath) {
        ffmpegArgs.push(
          '-i', tags.coverPath,
          '-map', '0:a',
          '-map', '1:v',
          '-c:a', 'copy',
          '-c:v', 'mjpeg',
          '-disposition:v:0', 'attached_pic'
        );
      } else {
        ffmpegArgs.push('-map', '0', '-c', 'copy');
      }

      ffmpegArgs.push(
        '-id3v2_version', '3',
        '-metadata', `title=${newTitle}`,
        '-metadata', `artist=${newArtist}`,
        '-metadata', `album=${newAlbum}`,
        outputAudioPath
      );

      await execFile('ffmpeg', ffmpegArgs, { timeout: 60000, signal });

      const stats = await fs.stat(outputAudioPath);
      return {
        audioPath: outputAudioPath,
        duration: Math.floor(existing.duration),
        title: newTitle,
        artist: newArtist,
        fileSize: stats.size
      };
    } catch (err) {
      try { await fs.unlink(outputAudioPath); } catch {}
      throw err;
    }
  }
}

module.exports = new AudioService();
