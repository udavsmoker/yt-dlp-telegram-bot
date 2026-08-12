const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { generateFilename, ensureDir } = require('../utils/helpers');
const config = require('../config');
const logger = require('../utils/logger');

class AudioService {
  /**
   * Convert a video file to MP3 audio
   * @param {string} videoPath - absolute path to the video file
   * @returns {Promise<{audioPath: string, duration: number, title: string, artist: string, fileSize: number}>}
   */
  async convertToMp3(videoPath) {
    await ensureDir(config.download.tempDir);
    
    const audioFilename = generateFilename('audio', 'mp3');
    const audioPath = path.join(config.download.tempDir, audioFilename);
    
    try {
      // Extract audio metadata first
      let duration = 0;
      let title = 'Audio';
      let artist = 'Unknown';
      
      try {
        const metadata = execSync(
          `ffprobe -v error -show_entries format=duration:format_tags=title,artist,author -of json "${videoPath}"`,
          { encoding: 'utf8', timeout: 10000 }
        );
        const parsed = JSON.parse(metadata);
        if (parsed.format) {
          duration = parseFloat(parsed.format.duration) || 0;
          if (parsed.format.tags) {
            title = parsed.format.tags.title || 'Audio';
            artist = parsed.format.tags.artist || parsed.format.tags.author || 'Unknown';
          }
        }
      } catch (e) {
        logger.warn(`Could not get audio metadata: ${e.message}`);
      }
      
      // Convert to MP3
      execSync(
        `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -ab 192k -ar 44100 "${audioPath}"`,
        { stdio: 'ignore', timeout: 120000 }
      );
      
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
}

module.exports = new AudioService();
