import { describe, expect, it } from 'vitest';
import { createPageGenRateLimiter } from '../rateLimit';

describe('createPageGenRateLimiter', () => {
  it('allows one generation in flight per user, others are independent', () => {
    const limiter = createPageGenRateLimiter({ maxPerWindow: 5, windowMs: 1000 });
    const a = limiter.acquire('a', 0);
    expect(a.ok).toBe(true);
    expect(limiter.acquire('a', 1)).toMatchObject({ ok: false, reason: 'in_flight' });
    expect(limiter.acquire('b', 1).ok).toBe(true);
    if (a.ok) {
      a.release();
      a.release(); // idempotent
    }
    expect(limiter.acquire('a', 2).ok).toBe(true);
  });

  it('caps starts per sliding window and says when the next one is allowed', () => {
    const limiter = createPageGenRateLimiter({ maxPerWindow: 2, windowMs: 10_000 });
    for (const t of [0, 1000]) {
      const r = limiter.acquire('a', t);
      if (r.ok) r.release();
    }
    expect(limiter.acquire('a', 2000)).toEqual({ ok: false, reason: 'too_many', retryAfterSec: 8 });
    expect(limiter.acquire('a', 10_001).ok).toBe(true);
  });
});
