// src/lib/ai/review/rateLimit.ts
//
// Per-user budget for visual reviews: one in flight per user and at most
// REVIEW_RATE.maxPerWindow per window. Its own limiter instance (the same
// process-local mechanism as page generation, src/lib/ai/pageGen/rateLimit.ts),
// so a review that follows a generation never collides with that
// generation's slot, and the two budgets are reset independently in tests.

import { createPageGenRateLimiter, type PageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';

export const REVIEW_RATE = {
  maxPerWindow: 20,
  windowMs: 10 * 60 * 1000,
} as const;

let _limiter: PageGenRateLimiter | null = null;

export function getReviewRateLimiter(): PageGenRateLimiter {
  if (!_limiter) _limiter = createPageGenRateLimiter(REVIEW_RATE);
  return _limiter;
}

/** Test-only: start from an empty limiter. */
export function __resetReviewRateLimiterForTests(): void {
  _limiter = null;
}
