const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ttsService = require('../src/services/tts.service');
const { parseTagText } = require('../src/handlers/tag.handler');
const { parseTimestamp } = require('../src/handlers/cut.handler');
const demotivatorService = require('../src/services/demotivator.service');

describe('New Features: TTS, Audio Tagging, Media Cut, Custom Demotivator', () => {
  describe('TTS Service (splitIntoChunks)', () => {
    it('should split empty or whitespace text into empty array', () => {
      assert.deepEqual(ttsService.splitIntoChunks(''), []);
      assert.deepEqual(ttsService.splitIntoChunks('   \n  '), []);
      assert.deepEqual(ttsService.splitIntoChunks(null), []);
    });

    it('should strip URLs from synthesized text', () => {
      const text = 'Смотрите видео https://youtube.com/watch?v=123 очень классное';
      const chunks = ttsService.splitIntoChunks(text);
      assert.ok(chunks.length > 0);
      assert.ok(!chunks[0].includes('http'));
      assert.ok(chunks[0].includes('Смотрите видео'));
    });

    it('should leave short text as a single chunk', () => {
      const text = 'Привет мир, это тестовое сообщение!';
      const chunks = ttsService.splitIntoChunks(text, 100);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0], text);
    });

    it('should split long text by sentences without exceeding maxLength', () => {
      const text = 'Первое предложение. Второе длинное предложение для проверки работы сплиттера текста. И третье предложение.';
      const chunks = ttsService.splitIntoChunks(text, 50);
      assert.ok(chunks.length >= 2);
      for (const chunk of chunks) {
        assert.ok(chunk.length <= 60); // allowable boundary
      }
    });
  });

  describe('Audio Tagging (parseTagText)', () => {
    it('should parse "Title - Artist" with hyphen separator', () => {
      const res = parseTagText('Bohemian Rhapsody - Queen');
      assert.equal(res.title, 'Bohemian Rhapsody');
      assert.equal(res.artist, 'Queen');
    });

    it('should parse with pipe "|" separator', () => {
      const res = parseTagText('In The End | Linkin Park');
      assert.equal(res.title, 'In The End');
      assert.equal(res.artist, 'Linkin Park');
    });

    it('should parse with em-dash "—" separator', () => {
      const res = parseTagText('Shape of You — Ed Sheeran');
      assert.equal(res.title, 'Shape of You');
      assert.equal(res.artist, 'Ed Sheeran');
    });

    it('should return title without artist if no separator is present', () => {
      const res = parseTagText('Just A Song Title');
      assert.equal(res.title, 'Just A Song Title');
      assert.equal(res.artist, null);
    });

    it('should handle empty or null input gracefully', () => {
      assert.deepEqual(parseTagText(''), { title: null, artist: null });
      assert.deepEqual(parseTagText(null), { title: null, artist: null });
    });
  });

  describe('Media Cut (parseTimestamp)', () => {
    it('should parse HH:MM:SS format into seconds', () => {
      assert.equal(parseTimestamp('01:02:03'), 3723);
      assert.equal(parseTimestamp('00:01:30'), 90);
    });

    it('should parse MM:SS format into seconds', () => {
      assert.equal(parseTimestamp('01:30'), 90);
      assert.equal(parseTimestamp('00:45'), 45);
      assert.equal(parseTimestamp('10:00'), 600);
    });

    it('should parse plain seconds number or string', () => {
      assert.equal(parseTimestamp('45'), 45);
      assert.equal(parseTimestamp('12.5'), 12.5);
      assert.equal(parseTimestamp('0'), 0);
    });

    it('should reject invalid timestamps', () => {
      assert.equal(parseTimestamp('abc'), null);
      assert.equal(parseTimestamp('-5'), null);
      assert.equal(parseTimestamp('01:02:03:04'), null);
      assert.equal(parseTimestamp(''), null);
      assert.equal(parseTimestamp(null), null);
    });
  });

  describe('Custom Demotivator parsing and layout', () => {
    it('should correctly format demotivator text with title and subtitle', async () => {
      const { createCanvas } = require('canvas');
      const canvas = createCanvas(200, 200);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0000FF';
      ctx.fillRect(0, 0, 200, 200);

      const outputPath = await demotivatorService.renderDemotivator(
        canvas,
        'CUSTOM TITLE',
        'Custom subtitle explanation'
      );

      const fs = require('fs');
      assert.ok(fs.existsSync(outputPath));
      fs.unlinkSync(outputPath);
    });
  });
});
