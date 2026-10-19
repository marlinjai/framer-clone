// src/lib/ai/pageGen/rateLimit.ts
//
// Per-user budget for page generations: at most one generation in flight per
// user, and at most PAGE_GEN_RATE.maxPerWindow started per sliding window.
//
// Process-local (a Map in memory): it does not survive a restart and is not
// shared across instances. framer-clone runs as one Coolify container today, so
// this bounds what one user can spend; a durable per-company quota belongs to
// the usage-metering work (src/lib/ai/aiUsageStub.ts is its placeholder).

export const PAGE_GEN_RATE = {
  maxPerWindow: 10,
  windowMs: 10 * 60 * 1000,
} as const;

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'in_flight' | 'too_many'; retryAfterSec: number };

export interface PageGenRateLimiter {
  acquire(userId: string, now?: number): AcquireResult;
}

export function createPageGenRateLimiter(
  limits: { maxPerWindow: number; windowMs: number } = PAGE_GEN_RATE,
): PageGenRateLimiter {
  const starts = new Map<string, number[]>();
  const inFlight = new Set<string>();

  return {
    acquire(userId, now = Date.now()) {
      if (inFlight.has(userId)) {
        return { ok: false, reason: 'in_flight', retryAfterSec: 5 };
      }
      const recent = (starts.get(userId) ?? []).filter((t) => now - t < limits.windowMs);
      if (recent.length >= limits.maxPerWindow) {
        const oldest = recent[0];
        starts.set(userId, recent);
        return {
          ok: false,
          reason: 'too_many',
          retryAfterSec: Math.max(1, Math.ceil((limits.windowMs - (now - oldest)) / 1000)),
        };
      }
      recent.push(now);
      starts.set(userId, recent);
      inFlight.add(userId);
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          inFlight.delete(userId);
        },
      };
    },
  };
}

let _limiter: PageGenRateLimiter | null = null;

export function getPageGenRateLimiter(): PageGenRateLimiter {
  if (!_limiter) _limiter = createPageGenRateLimiter();
  return _limiter;
}

/** Test-only: start from an empty limiter. */
export function __resetPageGenRateLimiterForTests(): void {
  _limiter = null;
}
