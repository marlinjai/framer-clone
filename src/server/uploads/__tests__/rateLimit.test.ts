// The per-user upload limit (rateLimit.ts): every attempt counts, per user and
// per kind of upload, the window slides, and the 429 says when to try again.

import { describe, expect, it } from 'vitest';

import { createUploadRateLimiter, uploadRateLimitedResponse } from '../rateLimit';

describe('createUploadRateLimiter', () => {
  it('allows the limit per user and area, then refuses until the window has moved', () => {
    const limiter = createUploadRateLimiter({ max: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) expect(limiter.hit('site-images', 'u1', 1000 + i).ok).toBe(true);
    const refused = limiter.hit('site-images', 'u1', 2000);
    expect(refused).toEqual({ ok: false, retryAfterSec: 59 });
    // Another user, and the same user elsewhere, have their own windows.
    expect(limiter.hit('site-images', 'u2', 2000).ok).toBe(true);
    expect(limiter.hit('catalog-images', 'u1', 2000).ok).toBe(true);
    // Once the first hits leave the window, uploads are allowed again.
    expect(limiter.hit('site-images', 'u1', 61_001).ok).toBe(true);
  });
});

describe('uploadRateLimitedResponse', () => {
  it('answers 429 with Retry-After and a message naming the wait', async () => {
    const res = uploadRateLimitedResponse(90);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('90');
    const { error } = await res.json();
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterSec: 90 });
    expect(error.message).toMatch(/Wait about 2 minutes/);
  });
});
