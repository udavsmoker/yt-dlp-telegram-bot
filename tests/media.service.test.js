const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createCanvas } = require('canvas');

const demotivatorService = require('../src/services/demotivator.service');
const memeService = require('../src/services/meme.service');

describe('Media Services (Demotivators & Memes)', () => {
  describe('DemotivatorService text rendering and layout', () => {
    it('should wrap text within maximum width', () => {
      const canvas = createCanvas(800, 600);
      const ctx = canvas.getContext('2d');
      ctx.font = '30px "Times New Roman"';

      const longText = 'This is a very long text that must be wrapped across multiple lines on canvas';
      const lines = demotivatorService.wrapText(ctx, longText, 300, 30);

      assert.ok(Array.isArray(lines));
      assert.ok(lines.length > 1);
    });

    it('should fit text dynamically by reducing font size', () => {
      const canvas = createCanvas(800, 600);
      const ctx = canvas.getContext('2d');

      const text = 'Testing dynamic text fitting algorithm';
      const { fontSize, lines } = demotivatorService.fitText(ctx, text, 400, 100, 36, 18, 2);

      assert.ok(fontSize >= 18 && fontSize <= 36);
      assert.ok(lines.length <= 2);
    });

    it('should render a complete demotivator image to disk and clean up', async () => {
      await demotivatorService.init();

      // Create a test 200x200 canvas to use as source image
      const srcCanvas = createCanvas(200, 200);
      const srcCtx = srcCanvas.getContext('2d');
      srcCtx.fillStyle = '#FF0000';
      srcCtx.fillRect(0, 0, 200, 200);

      const outputPath = await demotivatorService.renderDemotivator(
        srcCanvas,
        'DEMOTIVATOR TITLE',
        'Subtitle explanation text'
      );

      assert.ok(fs.existsSync(outputPath));
      const stats = fs.statSync(outputPath);
      assert.ok(stats.size > 0);

      // Clean up test file
      fs.unlinkSync(outputPath);
    });
  });

  describe('MemeService templates and metadata', () => {
    it('should load template configurations from templates folder', async () => {
      await memeService.init();
      const templates = memeService.getTemplateList();

      assert.ok(Array.isArray(templates));
      assert.ok(templates.length >= 1);

      const template = templates[0];
      assert.ok(template.name);
      assert.ok(typeof template.textBoxCount === 'number');
    });

    it('should render text box on canvas without throwing errors', () => {
      const canvas = createCanvas(600, 600);
      const ctx = canvas.getContext('2d');
      const box = {
        x: 50,
        y: 50,
        width: 300,
        height: 100,
        fontSize: 24,
        align: 'center',
        fontColor: '#FFFFFF',
        strokeColor: '#000000',
        strokeWidth: 2
      };

      assert.doesNotThrow(() => {
        memeService.drawTextBox(ctx, box, 'Top text line for meme');
      });
    });
  });
});
