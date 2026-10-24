import { describe, expect, it } from 'vitest';
import { SlidingWindow, createFormRateLimiter } from '../rateLimit';

describe('SlidingWindow', () => {
  it('allows max hits per window and frees them as the window slides', () => {
    const w = new SlidingWindow({ max: 2, windowMs: 1000 });
    expect(w.hit('a', 0).ok).toBe(true);
    expect(w.hit('a', 100).ok).toBe(true);
    const blocked = w.hit('a', 200);
    expect(blocked).toEqual({ ok: false, retryAfterSec: 1 });
    expect(w.hit('a', 1001).ok).toBe(true);
  });

  it('is bounded: the least recently used keys are dropped', () => {
    const w = new SlidingWindow({ max: 1, windowMs: 60_000 }, 3);
    for (const k of ['a', 'b', 'c', 'd']) w.hit(k, 0);
    expect(w.size).toBe(3);
    // 'a' was evicted, so it may hit again; 'd' is still limited.
    expect(w.hit('a', 1).ok).toBe(true);
    expect(w.hit('d', 1).ok).toBe(false);
  });
});

describe('createFormRateLimiter.accept', () => {
  it('records nothing when either limit refuses', () => {
    const l = createFormRateLimiter({ flood: { max: 9, windowMs: 1000 }, ip: { max: 1, windowMs: 1000 }, form: { max: 2, windowMs: 1000 } });
    expect(l.accept('ip1', 'f', 0).ok).toBe(true);
    expect(l.accept('ip1', 'f', 1).ok).toBe(false); // ip limit; the form count stays 1
    expect(l.accept('ip2', 'f', 2).ok).toBe(true); // the form's second
    expect(l.accept('ip3', 'f', 3).ok).toBe(false); // form limit
  });
});
