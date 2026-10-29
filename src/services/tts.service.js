const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const config = require('../config');
const logger = require('../utils/logger');
const { generateFilename, ensureDir } = require('../utils/helpers');

class TtsService {
  /**
   * Split text into digestible chunks for TTS API (max 180 chars per chunk)
   * @param {string} text
   * @returns {string[]}
   */
  splitIntoChunks(text, maxLength = 180) {
    if (!text || typeof text !== 'string') return [];
    const clean = text.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];

    if (clean.length <= maxLength) return [clean];

    const chunks = [];
    const sentences = clean.split(/([.!?\n]+)/g);
    let current = '';

    for (let i = 0; i < sentences.length; i++) {
      const part = sentences[i];
      if ((current + part).length <= maxLength) {
        current += part;
      } else {
        if (current.trim()) chunks.push(current.trim());
        if (part.length <= maxLength) {
          current = part;
        } else {
          // Break by words
          const words = part.split(' ');
          current = '';
          for (const w of words) {
            if ((current + ' ' + w).length <= maxLength) {
              current = current ? current + ' ' + w : w;
            } else {
              if (current.trim()) chunks.push(current.trim());
              current = w;
            }
          }
        }
      }
    }

    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  /**
   * Synthesize text to speech and convert directly to Telegram Voice Note (.ogg Opus).
   * @param {string} text - Text to synthesize
   * @param {object} [options={}] - { lang: 'ru', signal }
   * @returns {Promise<{ filePath: string, duration: number }>}
   */
  async synthesizeToOggOpus(text, options = {}) {
    await ensureDir(config.download.tempDir);
    const lang = options.lang || 'ru';
    const signal = options.signal;

    const chunks = this.splitIntoChunks(text, 180);
    if (chunks.length === 0) {
      throw new Error('No readable text to synthesize');
    }

    const tempFiles = [];
    const outputFilename = generateFilename('voice', 'ogg');
    const outputPath = path.join(config.download.tempDir, outputFilename);

    try {
      // Download audio chunks
      for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) throw new Error('DOWNLOAD_CANCELLED');
        const chunkText = chunks[i];
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunkText)}&tl=${encodeURIComponent(lang)}&client=tw-ob`;

        const res = await axios.get(url, {
          responseType: 'arraybuffer',
          signal,
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://translate.google.com/'
          }
        });

        const chunkPath = path.join(config.download.tempDir, `tts_chunk_${Date.now()}_${i}.mp3`);
        await fs.writeFile(chunkPath, res.data);
        tempFiles.push(chunkPath);
      }

      if (tempFiles.length === 1) {
        // Single chunk: convert directly to Telegram OGG Opus
        await execFile('ffmpeg', [
          '-y',
          '-i', tempFiles[0],
          '-c:a', 'libopus',
          '-b:a', '32k',
          '-vbr', 'on',
          outputPath
        ], { timeout: 30000, signal });
      } else {
        // Multiple chunks: concatenate and convert
        const listFile = path.join(config.download.tempDir, `concat_${Date.now()}.txt`);
        tempFiles.push(listFile);
        const listContent = tempFiles.slice(0, -1).map(f => `file '${f}'`).join('\n');
        await fs.writeFile(listFile, listContent, 'utf8');

        await execFile('ffmpeg', [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listFile,
          '-c:a', 'libopus',
          '-b:a', '32k',
          '-vbr', 'on',
          outputPath
        ], { timeout: 60000, signal });
      }

      // Probe duration
      let duration = 0;
      try {
        const { stdout: probe } = await execFile('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'json',
          outputPath
        ], { encoding: 'utf8', timeout: 5000, signal });
        const parsed = JSON.parse(probe);
        duration = Math.ceil(parseFloat(parsed.format?.duration) || 0);
      } catch {}

      return { filePath: outputPath, duration };
    } catch (err) {
      await fs.unlink(outputPath).catch(() => {});
      throw err;
    } finally {
      for (const f of tempFiles) {
        await fs.unlink(f).catch(() => {});
      }
    }
  }
}

module.exports = new TtsService();
