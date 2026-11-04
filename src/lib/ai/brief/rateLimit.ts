// src/lib/ai/brief/rateLimit.ts
//
// Per-user budgets of the two brief helpers, built on the page generator's
// limiter (src/lib/ai/pageGen/rateLimit.ts): at most 20 started per user and
// helper in a sliding 10-minute window, and for Enhance one in flight at a
// time (its button is disabled while one runs). Ideas have no in-flight rule:
// switching the target quickly aborts one fetch and starts the next, and the
// aborted call may still hold its slot on the server for a moment. Each
// call is one small Haiku request, so 20 is far above what a person clicking
// "More ideas" or "Enhance" needs and still bounds a runaway script.
//
// Process-local, like the generator's limiter (one container today).

import { createPageGenRateLimiter, type PageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';

export const BRIEF_RATE = {
  maxPerWindow: 20,
  windowMs: 10 * 60 * 1000,
} as const;

let _ideas: PageGenRateLimiter | null = null;
let _enhance: PageGenRateLimiter | null = null;

/** The window count only: the in-flight slot is given back at once. */
function windowOnly(limiter: PageGenRateLimiter): PageGenRateLimiter {
  return {
    acquire(userId, now) {
      const slot = limiter.acquire(userId, now);
      if (slot.ok) slot.release(); // idempotent: the caller's release stays a no-op
      return slot;
    },
  };
}

export function getIdeasRateLimiter(): PageGenRateLimiter {
  if (!_ideas) _ideas = windowOnly(createPageGenRateLimiter(BRIEF_RATE));
  return _ideas;
}

export function getEnhanceRateLimiter(): PageGenRateLimiter {
  if (!_enhance) _enhance = createPageGenRateLimiter(BRIEF_RATE);
  return _enhance;
}

/** Test-only: start both limiters empty. */
export function __resetBriefRateLimitersForTests(): void {
  _ideas = null;
  _enhance = null;
}

/** The 429 message for a refused slot. */
export function rateLimitMessage(what: 'ideas' | 'enhance', reason: 'in_flight' | 'too_many', retryAfterSec: number): string {
  if (reason === 'in_flight') {
    return what === 'ideas' ? 'Ideas are still loading. Wait a moment.' : 'An Enhance is still running. Wait for it to finish.';
  }
  const label = what === 'ideas' ? 'Idea' : 'Enhance';
  return `${label} limit reached. Try again in ${retryAfterSec} seconds.`;
}
