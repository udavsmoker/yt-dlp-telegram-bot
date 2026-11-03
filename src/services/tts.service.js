const path = require('path');
const fs = require('fs').promises;
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { EdgeTTS } = require('@andresaya/edge-tts');
const config = require('../config');
const logger = require('../utils/logger');
const { generateFilename, ensureDir } = require('../utils/helpers');

const VOICE_PRESETS = {
  normal: { female: true },
  demon: {},
  slow: { female: true, rate: '-18%' },
  fast: { female: true, rate: '+30%' }
};

const NATIVE_VOICES = {
  ru: { female: 'ru-RU-SvetlanaNeural', male: 'ru-RU-DmitryNeural' },
  en: { female: 'en-US-JennyNeural', male: 'en-US-GuyNeural' },
  de: { female: 'de-DE-KatjaNeural', male: 'de-DE-ConradNeural' },
  ja: { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
  es: { female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' },
  fr: { female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' },
  uk: { female: 'uk-UA-PolinaNeural', male: 'uk-UA-OstapNeural' }
};

class TtsService {
  /**
   * Resolve a preset to a native neural voice for the requested language.
   * @param {string} voice
   * @param {string} lang
   * @returns {{ name: string, rate?: string }|null}
   */
  getVoiceForLanguage(voice, lang = 'ru') {
    if (!voice) return null;
    const key = String(voice).toLowerCase().replace(/^[-/]+/, '').trim();
    const preset = VOICE_PRESETS[key];
    if (!preset) return null;
    const language = String(lang).toLowerCase().split('-')[0];
    const voices = NATIVE_VOICES[language] || NATIVE_VOICES.en;
    return {
      name: preset.female ? voices.female : voices.male,
      ...(preset.rate ? { rate: preset.rate } : {})
    };
  }

  /**
   * Pick a random voice preset for Markov/bot voice messages.
   * @returns {string}
   */
  getRandomVoice() {
    const pool = ['normal', 'demon'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

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
   * @param {object} [options={}] - { lang: 'ru', voice: 'normal', signal }
   * @returns {Promise<{ filePath: string, duration: number }>}
   */
  async synthesizeToOggOpus(text, options = {}) {
    await ensureDir(config.download.tempDir);
    const lang = options.lang || 'ru';
    const voice = options.voice || 'normal';
    const nativeVoice = this.getVoiceForLanguage(voice, lang) || this.getVoiceForLanguage('normal', lang);
    const signal = options.signal;

    const chunks = this.splitIntoChunks(text, 1000);
    if (chunks.length === 0) {
      throw new Error('No readable text to synthesize');
    }

    const tempFiles = [];
    const outputFilename = generateFilename('voice', 'ogg');
    const outputPath = path.join(config.download.tempDir, outputFilename);

    try {
      const tts = new EdgeTTS({ timeout: 30000 });

      // Generate audio remotely; the small server only stores the returned MP3 chunks.
      for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) throw new Error('DOWNLOAD_CANCELLED');
        const chunkText = chunks[i];
        const result = await tts.generate(chunkText, nativeVoice.name, {
          rate: nativeVoice.rate || '+0%',
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
          signal,
          timeout: 30000
        });

        const chunkPath = path.join(config.download.tempDir, `tts_chunk_${Date.now()}_${i}.mp3`);
        await fs.writeFile(chunkPath, result.audio);
        tempFiles.push(chunkPath);
      }

      if (tempFiles.length === 1) {
        // Single chunk: convert directly to Telegram OGG Opus
        const ffmpegArgs = ['-y', '-i', tempFiles[0]];
        ffmpegArgs.push('-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', outputPath);
        await execFile('ffmpeg', ffmpegArgs, { timeout: 30000, signal });
      } else {
        // Multiple chunks: concatenate and convert
        const listFile = path.join(config.download.tempDir, `concat_${Date.now()}.txt`);
        tempFiles.push(listFile);
        const listContent = tempFiles.slice(0, -1).map(f => `file '${f}'`).join('\n');
        await fs.writeFile(listFile, listContent, 'utf8');

        const ffmpegArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
        ffmpegArgs.push('-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', outputPath);
        await execFile('ffmpeg', ffmpegArgs, { timeout: 60000, signal });
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
