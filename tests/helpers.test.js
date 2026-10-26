const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractUrl,
  isValidVideoUrl,
  isYouTubeUrl,
  isTikTokUrl,
  isTikTokPhotoUrl,
  isInstagramUrl,
  isInstagramPostUrl,
  getInstagramImgIndex,
  isBlueskyUrl,
  isBlueskyPostUrl,
  renderProgressBar,
  formatFileSize,
  formatDuration,
  generateFilename,
  getUserInfo
} = require('../src/utils/helpers');

describe('Helpers & Utilities', () => {
  describe('extractUrl', () => {
    it('should extract plain URL from text', () => {
      const url = extractUrl('check this out https://youtube.com/watch?v=123456 please');
      assert.equal(url, 'https://youtube.com/watch?v=123456');
    });

    it('should return null when URL is not preceded by http/https', () => {
      const url = extractUrl('look at www.tiktok.com/@user/video/123');
      assert.equal(url, null);
    });

    it('should trim trailing punctuation from extracted URL', () => {
      const url = extractUrl('Watch this: https://youtube.com/watch?v=abc,...');
      assert.equal(url, 'https://youtube.com/watch?v=abc');
    });

    it('should return null when no URL present', () => {
      const url = extractUrl('just some random text without any link');
      assert.equal(url, null);
    });
  });

  describe('isValidVideoUrl', () => {
    it('should accept valid URLs across supported platforms', () => {
      assert.equal(isValidVideoUrl('https://www.youtube.com/watch?v=abc'), true);
      assert.equal(isValidVideoUrl('https://instagram.com/reel/xyz/'), true);
      assert.equal(isValidVideoUrl('https://tiktok.com/@user/video/123'), true);
      assert.equal(isValidVideoUrl('https://bsky.app/profile/user/post/123'), true);
    });

    it('should reject invalid, malformed, or suspicious URLs', () => {
      assert.equal(isValidVideoUrl('not-a-url'), false);
      assert.equal(isValidVideoUrl(''), false);
      assert.equal(isValidVideoUrl(null), false);
      assert.equal(isValidVideoUrl('https://youtube.com/?@evil.com'), false);
      assert.equal(isValidVideoUrl('https://youtu.be/'), false);
    });
  });

  describe('Platform URL Detectors', () => {
    it('should detect YouTube URLs correctly', () => {
      assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
      assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
      assert.equal(isYouTubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ'), true);
      assert.equal(isYouTubeUrl('https://vimeo.com/12345'), false);
    });

    it('should detect TikTok URLs correctly', () => {
      assert.equal(isTikTokUrl('https://www.tiktok.com/@username/video/1234567890'), true);
      assert.equal(isTikTokUrl('https://vm.tiktok.com/ZM8abcde/'), true);
      assert.equal(isTikTokUrl('https://vt.tiktok.com/ZS8abcde/'), true);
      assert.equal(isTikTokPhotoUrl('https://www.tiktok.com/@username/photo/1234567890'), true);
      assert.equal(isTikTokUrl('https://instagram.com/reel/123'), false);
    });

    it('should detect Instagram URLs and image indexes', () => {
      assert.equal(isInstagramUrl('https://www.instagram.com/reel/C12345/'), true);
      assert.equal(isInstagramUrl('https://instagram.com/stories/user/123/'), true);
      assert.equal(isInstagramPostUrl('https://www.instagram.com/p/C12345/'), true);
      assert.equal(isInstagramPostUrl('https://www.instagram.com/reel/C12345/'), true);

      assert.equal(getInstagramImgIndex('https://www.instagram.com/p/C12345/?img_index=3'), 3);
      assert.equal(getInstagramImgIndex('https://www.instagram.com/p/C12345/?img_index=1'), 1);
      assert.equal(getInstagramImgIndex('https://www.instagram.com/p/C12345/'), null);
    });

    it('should detect Bluesky URLs correctly', () => {
      assert.equal(isBlueskyUrl('https://bsky.app/profile/user.bsky.social/post/3kabc123'), true);
      assert.equal(isBlueskyPostUrl('https://bsky.app/profile/user.bsky.social/post/3kabc123'), true);
      assert.equal(isBlueskyPostUrl('https://bsky.app/profile/user.bsky.social'), false);
    });
  });

  describe('renderProgressBar', () => {
    it('should render 0% progress correctly', () => {
      const bar = renderProgressBar(0);
      assert.ok(bar.includes('0%'));
      assert.ok(bar.includes('░░░░░░░░░░'));
    });

    it('should render 50% progress correctly', () => {
      const bar = renderProgressBar(50);
      assert.ok(bar.includes('50%'));
      assert.ok(bar.includes('█████░░░░░'));
    });

    it('should render 100% progress correctly', () => {
      const bar = renderProgressBar(100);
      assert.ok(bar.includes('100%'));
      assert.ok(bar.includes('██████████'));
    });

    it('should round percent and include speed and ETA when provided', () => {
      const bar = renderProgressBar(45.5, '12.5MiB/s', '00:00:15');
      assert.ok(bar.includes('46%'));
      assert.ok(bar.includes('12.5MiB/s'));
      assert.ok(bar.includes('00:00:15'));
    });

    it('should sanitize placeholder speed and ETA', () => {
      const bar = renderProgressBar(30, 'Unknown B/s', '--:--');
      assert.ok(bar.includes('30%'));
      assert.ok(!bar.includes('Unknown B/s'));
      assert.ok(!bar.includes('--:--'));
    });
  });

  describe('formatters', () => {
    it('should format file sizes correctly', () => {
      assert.equal(formatFileSize(500), '500 B');
      assert.equal(formatFileSize(1024), '1.00 KB');
      assert.equal(formatFileSize(1048576), '1.00 MB');
      assert.equal(formatFileSize(1073741824), '1.00 GB');
      assert.equal(formatFileSize(null), 'Unknown');
    });

    it('should format duration in seconds to time string', () => {
      assert.equal(formatDuration(45), '0:45');
      assert.equal(formatDuration(125), '2:05');
      assert.equal(formatDuration(3665), '1:01:05');
      assert.equal(formatDuration(0), 'Unknown');
      assert.equal(formatDuration(-5), 'Unknown');
    });

    it('should generate valid filenames with timestamp and extension', () => {
      const filename = generateFilename('video', 'mp4');
      assert.ok(filename.startsWith('video_'));
      assert.ok(filename.endsWith('.mp4'));
    });

    it('should format user information from context', () => {
      const mockCtxUser = {
        from: { id: 12345, first_name: 'John', last_name: 'Doe', username: 'johndoe' },
        chat: { id: -1001, type: 'group' }
      };
      const info = getUserInfo(mockCtxUser);
      assert.equal(info, '@johndoe (12345)');

      const mockCtxChannel = {
        from: null,
        chat: { id: -10099, title: 'My Cool Channel' }
      };
      assert.equal(getUserInfo(mockCtxChannel), 'channel "My Cool Channel" (-10099)');
    });
  });
});
