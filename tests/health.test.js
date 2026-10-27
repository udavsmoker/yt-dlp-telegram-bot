const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatUptime, handleHealth } = require('../src/handlers/health.handler');

describe('Health Handler & Diagnostics', () => {
  describe('formatUptime', () => {
    it('should format seconds only', () => {
      assert.equal(formatUptime(45), '45s');
    });

    it('should format minutes and seconds', () => {
      assert.equal(formatUptime(125), '2m 5s');
    });

    it('should format hours, minutes, and seconds', () => {
      assert.equal(formatUptime(3665), '1h 1m 5s');
    });

    it('should format days, hours, minutes, and seconds', () => {
      assert.equal(formatUptime(90065), '1d 1h 1m 5s');
    });
  });

  describe('handleHealth', () => {
    it('should reply with clean operational diagnostics', async () => {
      let replyText = '';
      let replyOpts = null;

      const ctx = {
        from: { id: 123, first_name: 'TestUser' },
        chat: { id: 100 },
        message: { date: Math.floor(Date.now() / 1000) - 1 },
        reply: async (text, opts) => {
          replyText = text;
          replyOpts = opts;
        }
      };

      await handleHealth(ctx);

      assert.equal(replyOpts?.parse_mode, 'HTML');
      assert.match(replyText, /<b>System Health<\/b>/);
      assert.match(replyText, /• <b>Status:<\/b> Operational/);
      assert.match(replyText, /• <b>Uptime:<\/b>/);
      assert.match(replyText, /• <b>Queue:<\/b>/);
      assert.match(replyText, /• <b>Memory:<\/b>/);
      assert.match(replyText, /• <b>Cache:<\/b>/);
      assert.match(replyText, /• <b>API:<\/b>/);
      assert.match(replyText, /• <b>Runtime:<\/b> Node\.js/);
      assert.match(replyText, /• <b>Latency:<\/b>/);
    });
  });
});
