const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

class CacheService {
  constructor(customDbPath = null) {
    this.enabled = config.cache?.enabled !== false;
    this.ttlMs = (config.cache?.ttlHours || 48) * 60 * 60 * 1000;
    this.db = null;

    if (this.enabled) {
      this.initDatabase(customDbPath);
      if (customDbPath !== ':memory:') {
        this.cleanupInterval = setInterval(() => {
          this.cleanExpired();
        }, 60 * 60 * 1000);
        if (this.cleanupInterval.unref) {
          this.cleanupInterval.unref();
        }
      }
    }
  }

  initDatabase(customDbPath = null) {
    try {
      const dbTarget = customDbPath || path.join(__dirname, '../../data/cache.db');
      if (dbTarget !== ':memory:') {
        const dbDir = path.dirname(dbTarget);
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }
      }

      this.db = new Database(dbTarget);
      if (dbTarget !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS video_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url_hash TEXT NOT NULL UNIQUE,
          normalized_url TEXT NOT NULL,
          original_url TEXT NOT NULL,
          file_type TEXT NOT NULL DEFAULT 'video',
          file_id TEXT NOT NULL,
          file_size INTEGER,
          platform TEXT,
          title TEXT,
          author TEXT,
          duration TEXT,
          quality TEXT,
          width INTEGER,
          height INTEGER,
          caption_info TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          hit_count INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_cache_url_hash ON video_cache(url_hash);
        CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON video_cache(expires_at);
      `);

      this.stmtGet = this.db.prepare('SELECT * FROM video_cache WHERE url_hash = ? AND expires_at > ?');
      this.stmtHit = this.db.prepare('UPDATE video_cache SET hit_count = hit_count + 1 WHERE id = ?');
      this.stmtSet = this.db.prepare(`
        INSERT INTO video_cache (
          url_hash, normalized_url, original_url, file_type, file_id,
          file_size, platform, title, author, duration, quality,
          width, height, caption_info, created_at, expires_at
        ) VALUES (
          @url_hash, @normalized_url, @original_url, @file_type, @file_id,
          @file_size, @platform, @title, @author, @duration, @quality,
          @width, @height, @caption_info, @created_at, @expires_at
        )
        ON CONFLICT(url_hash) DO UPDATE SET
          file_id = excluded.file_id,
          file_type = excluded.file_type,
          file_size = excluded.file_size,
          platform = excluded.platform,
          title = excluded.title,
          author = excluded.author,
          duration = excluded.duration,
          quality = excluded.quality,
          width = excluded.width,
          height = excluded.height,
          caption_info = excluded.caption_info,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
      `);
      this.stmtDelete = this.db.prepare('DELETE FROM video_cache WHERE url_hash = ?');
      this.stmtDeleteExpired = this.db.prepare('DELETE FROM video_cache WHERE expires_at <= ?');
      this.stmtStats = this.db.prepare(`
        SELECT 
          COUNT(*) as total,
          COALESCE(SUM(hit_count), 0) as hits,
          COALESCE(SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END), 0) as active
        FROM video_cache
      `);

      logger.info('Cache database initialized successfully');
      this.cleanExpired();
    } catch (error) {
      logger.error('Failed to initialize cache database:', error);
      this.enabled = false;
    }
  }

  /**
   * Normalizes URLs by removing tracking query parameters and canonicalizing platform domains.
   */
  normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl.trim());
      let hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
      let pathname = parsed.pathname.replace(/\/+$/, '') || '/';

      // Canonicalize domain aliases
      if (hostname === 'm.youtube.com' || hostname === 'youtu.be') {
        if (hostname === 'youtu.be') {
          const videoId = pathname.slice(1);
          return `https://youtube.com/watch?v=${videoId}`;
        }
        hostname = 'youtube.com';
      } else if (hostname === 'twitter.com') {
        hostname = 'x.com';
      }

      // Platform-specific normalization
      if (hostname === 'youtube.com') {
        if (pathname === '/watch') {
          const v = parsed.searchParams.get('v');
          return v ? `https://youtube.com/watch?v=${v}` : `https://youtube.com${pathname}`;
        }
        if (pathname.startsWith('/shorts/')) {
          return `https://youtube.com${pathname}`;
        }
      }

      if (hostname === 'instagram.com') {
        // Retain img_index for specific carousel slide targeting, strip everything else
        const imgIndex = parsed.searchParams.get('img_index');
        const cleanPath = pathname.replace(/^\/share\/(reel|p)/, '/$1');
        return imgIndex ? `https://instagram.com${cleanPath}?img_index=${imgIndex}` : `https://instagram.com${cleanPath}`;
      }

      if (hostname === 'tiktok.com' || hostname === 'vm.tiktok.com' || hostname === 'vt.tiktok.com') {
        return `https://${hostname}${pathname}`;
      }

      if (hostname === 'x.com') {
        return `https://x.com${pathname}`;
      }

      if (hostname === 'bsky.app') {
        return `https://bsky.app${pathname}`;
      }

      // Generic cleanup: strip known tracking and telemetry parameters
      const trackingParams = [
        'si', 'obrf', 'feature', 'igsh', 'fbclid', 'gclid', 'ref', 'ref_src',
        'source', 'context', 't', 'time_continue', 'app'
      ];
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (key.startsWith('utm_') || trackingParams.includes(key.toLowerCase())) {
          parsed.searchParams.delete(key);
        }
      }

      parsed.searchParams.sort();
      const search = parsed.searchParams.toString();
      return `https://${hostname}${pathname}${search ? '?' + search : ''}`;
    } catch {
      return rawUrl.trim().toLowerCase();
    }
  }

  hashUrl(normalizedUrl) {
    return crypto.createHash('sha256').update(normalizedUrl).digest('hex');
  }

  get(rawUrl) {
    if (!this.enabled || !this.db) return null;
    try {
      const normalized = this.normalizeUrl(rawUrl);
      const hash = this.hashUrl(normalized);
      const row = this.stmtGet.get(hash, Date.now());

      if (row) {
        this.stmtHit.run(row.id);
        if (row.caption_info) {
          try {
            row.captionInfo = JSON.parse(row.caption_info);
          } catch {
            row.captionInfo = null;
          }
        }
        return row;
      }
      return null;
    } catch (error) {
      logger.error('Cache get error:', error);
      return null;
    }
  }

  set(rawUrl, data) {
    if (!this.enabled || !this.db || !data?.fileId) return false;
    try {
      const normalized = this.normalizeUrl(rawUrl);
      const hash = this.hashUrl(normalized);
      const now = Date.now();

      this.stmtSet.run({
        url_hash: hash,
        normalized_url: normalized,
        original_url: rawUrl,
        file_type: data.fileType || 'video',
        file_id: data.fileId,
        file_size: data.fileSize || null,
        platform: data.platform || null,
        title: data.title || null,
        author: data.author || null,
        duration: data.duration || null,
        quality: data.quality || null,
        width: data.width || null,
        height: data.height || null,
        caption_info: data.captionInfo ? JSON.stringify(data.captionInfo) : null,
        created_at: now,
        expires_at: now + this.ttlMs
      });
      return true;
    } catch (error) {
      logger.error('Cache set error:', error);
      return false;
    }
  }

  delete(rawUrl) {
    if (!this.enabled || !this.db) return false;
    try {
      const normalized = this.normalizeUrl(rawUrl);
      const hash = this.hashUrl(normalized);
      this.stmtDelete.run(hash);
      return true;
    } catch (error) {
      logger.error('Cache delete error:', error);
      return false;
    }
  }

  cleanExpired() {
    if (!this.enabled || !this.db) return 0;
    try {
      const result = this.stmtDeleteExpired.run(Date.now());
      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} expired cache entries`);
      }
      return result.changes;
    } catch (error) {
      logger.error('Cache cleanExpired error:', error);
      return 0;
    }
  }

  getStats() {
    if (!this.enabled || !this.db) {
      return { enabled: false, total: 0, hits: 0, active: 0 };
    }
    try {
      const stats = this.stmtStats.get(Date.now());
      return { enabled: true, ...stats };
    } catch (error) {
      logger.error('Cache getStats error:', error);
      return { enabled: true, total: 0, hits: 0, active: 0, error: error.message };
    }
  }
}

const instance = new CacheService();
instance.CacheService = CacheService;
module.exports = instance;
