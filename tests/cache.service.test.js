const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { CacheService } = require('../src/services/cache.service');

describe('CacheService (SQLite & URL Normalization)', () => {
  let cache;

  beforeEach(() => {
    cache = new CacheService(':memory:');
  });

  describe('normalizeUrl', () => {
    it('should strip YouTube tracking parameters (si, feature) and canonicalize domain', () => {
      const normalized = cache.normalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abcdef&feature=shared');
      assert.equal(normalized, 'https://youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('should convert youtu.be shortlinks to standard watch URLs', () => {
      const normalized = cache.normalizeUrl('https://youtu.be/dQw4w9WgXcQ?si=tracking123');
      assert.equal(normalized, 'https://youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('should canonicalize twitter.com to x.com and strip queries', () => {
      const normalized = cache.normalizeUrl('https://twitter.com/user/status/123456?s=20&t=xyz');
      assert.equal(normalized, 'https://x.com/user/status/123456');
    });

    it('should strip Instagram tracking query parameters while preserving img_index', () => {
      const single = cache.normalizeUrl('https://www.instagram.com/reel/C12345/?igsh=MTabcde==');
      assert.equal(single, 'https://instagram.com/reel/C12345');

      const carousel = cache.normalizeUrl('https://www.instagram.com/p/C12345/?img_index=2&igsh=MTabcde==');
      assert.equal(carousel, 'https://instagram.com/p/C12345?img_index=2');
    });

    it('should strip general marketing params (utm_source, etc.)', () => {
      const normalized = cache.normalizeUrl('https://vimeo.com/123456?utm_source=telegram&utm_medium=social');
      assert.equal(normalized, 'https://vimeo.com/123456');
    });
  });

  describe('Cache storage and retrieval', () => {
    it('should store and retrieve cached video metadata', () => {
      const url = 'https://youtube.com/watch?v=test1234';
      const ok = cache.set(url, {
        fileId: 'tg_file_id_video_999',
        fileType: 'video',
        title: 'Test Video',
        author: 'Creator',
        duration: 120,
        fileSize: 10485760
      });
      assert.equal(ok, true);

      const cached = cache.get(url);
      assert.ok(cached);
      assert.equal(cached.file_id, 'tg_file_id_video_999');
      assert.equal(cached.title, 'Test Video');
      assert.equal(parseFloat(cached.duration), 120);
      assert.equal(cached.file_type, 'video');
    });

    it('should return null for non-cached URLs', () => {
      const notFound = cache.get('https://youtube.com/watch?v=not_found');
      assert.equal(notFound, null);
    });

    it('should increment hit_count on access', () => {
      const url = 'https://youtube.com/watch?v=hit_counter';
      cache.set(url, {
        fileId: 'file_id_hits',
        fileType: 'video'
      });

      cache.get(url); // increments to 1
      cache.get(url); // increments to 2
      const record = cache.get(url); // reads 2, then increments to 3

      assert.equal(record.hit_count, 2);
    });

    it('should manually delete cache record by URL', () => {
      const url = 'https://youtube.com/watch?v=to_delete';
      cache.set(url, { fileId: 'delete_me' });
      assert.ok(cache.get(url));

      cache.delete(url);
      assert.equal(cache.get(url), null);
    });

    it('should clean expired cache entries', () => {
      const url = 'https://youtube.com/watch?v=expired';
      cache.set(url, {
        fileId: 'file_id_expired',
        fileType: 'video'
      });

      // Manually backdate expires_at
      cache.db.prepare('UPDATE video_cache SET expires_at = ?').run(Date.now() - 1000);

      const cleaned = cache.cleanExpired();
      assert.equal(cleaned, 1);

      const afterClean = cache.get(url);
      assert.equal(afterClean, null);
    });
  });
});
