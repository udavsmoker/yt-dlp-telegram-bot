const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter, rateLimitMiddleware } = require('../src/middleware/rate-limit.middleware');
const config = require('../src/config');

describe('RateLimiter & Middleware', () => {
  describe('RateLimiter class', () => {
    it('should allow requests within the limit', () => {
      const limiter = new RateLimiter({ windowMs: 1000, max: 3 });
      const user = 'user_1';

      assert.equal(limiter.check(user).limited, false);
      assert.equal(limiter.check(user).limited, false);
      assert.equal(limiter.check(user).limited, false);
    });

    it('should block requests that exceed the limit', () => {
      const limiter = new RateLimiter({ windowMs: 1000, max: 2 });
      const user = 'user_2';

      assert.equal(limiter.check(user).limited, false);
      assert.equal(limiter.check(user).limited, false);

      const blocked = limiter.check(user);
      assert.equal(blocked.limited, true);
      assert.ok(blocked.retryAfterMs > 0);
    });

    it('should allow requests again after window expires', async () => {
      const limiter = new RateLimiter({ windowMs: 100, max: 1 });
      const user = 'user_3';

      assert.equal(limiter.check(user).limited, false);
      assert.equal(limiter.check(user).limited, true);

      // Wait for window to pass
      await new Promise(r => setTimeout(r, 120));

      assert.equal(limiter.check(user).limited, false);
    });

    it('should clean up inactive keys from store', () => {
      const limiter = new RateLimiter({ windowMs: 50, max: 5 });
      limiter.check('temp_user');
      assert.ok(limiter.store.has('temp_user'));

      // Backdate timestamp
      limiter.store.set('temp_user', [Date.now() - 100]);
      limiter.cleanup();

      assert.equal(limiter.store.has('temp_user'), false);
    });
  });

  describe('rateLimitMiddleware', () => {
    it('should bypass rate limiting for channel posts', async () => {
      const middleware = rateLimitMiddleware();
      let nextCalled = false;
      const ctx = {
        chat: { type: 'channel' },
        from: null
      };

      await middleware(ctx, async () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    });

    it('should bypass rate limiting for configured admin user', async () => {
      const originalAdminId = config.adminUserId;
      config.adminUserId = 999999;

      const middleware = rateLimitMiddleware();
      let nextCalled = false;
      const ctx = {
        chat: { type: 'private' },
        from: { id: 999999 }
      };

      await middleware(ctx, async () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      config.adminUserId = originalAdminId;
    });

    it('should call next() for users under the limit', async () => {
      const middleware = rateLimitMiddleware();
      let nextCalled = false;
      const ctx = {
        chat: { type: 'group' },
        from: { id: 888123 }
      };

      await middleware(ctx, async () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    });
  });
});
