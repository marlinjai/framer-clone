// src/server/forms/rateLimit.ts
//
// Spam protection for the public form endpoint, without any third-party
// service: sliding-window counters per visitor IP and per form, in memory.
//
//   - `flood`: every POST from one IP (a bot hammering the endpoint), checked
//     before anything touches the database.
//   - `ip`:    accepted submissions from one IP (a person may send a few).
//   - `form`:  accepted submissions to one form from everyone (a distributed
//     flood against one form).
//
// Process-local, like the page generation limiter (src/lib/ai/pageGen/rateLimit.ts):
// framer-clone runs as one container today, so this bounds one process; a
// restart forgets the windows. The maps are bounded (oldest keys evicted), so a
// flood of distinct IPs cannot grow memory without limit. The IP is only ever a
// key of this map, never stored or logged in clear.

export interface WindowLimit {
  max: number;
  windowMs: number;
}

export const FORM_RATE_LIMITS = {
  flood: { max: 30, windowMs: 60_000 },
  ip: { max: 5, windowMs: 10 * 60_000 },
  form: { max: 60, windowMs: 60 * 60_000 },
} as const satisfies Record<string, WindowLimit>;

/** Most keys one window map holds before the least recently used ones are dropped. */
export const MAX_TRACKED_KEYS = 10_000;

export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: WindowLimit,
    private readonly maxKeys: number = MAX_TRACKED_KEYS,
  ) {}

  /** Would one more hit for `key` stay within the limit? Does not record. */
  check(key: string, now: number): LimitResult {
    const recent = this.recent(key, now);
    if (recent.length < this.limit.max) return { ok: true };
    const oldest = recent[0];
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((this.limit.windowMs - (now - oldest)) / 1000)) };
  }

  /** Record a hit for `key`. */
  record(key: string, now: number): void {
    const recent = this.recent(key, now);
    recent.push(now);
    // Re-insert so the Map's order is least recently used first.
    this.hits.delete(key);
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }

  /** Check and record in one step (for counters that count every attempt). */
  hit(key: string, now: number): LimitResult {
    const result = this.check(key, now);
    if (result.ok) this.record(key, now);
    return result;
  }

  get size(): number {
    return this.hits.size;
  }

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.limit.windowMs);
  }
}

export interface FormRateLimiter {
  /** Every POST, per IP, recorded. */
  flood(ip: string, now: number): LimitResult;
  /** Accepted submissions, per IP and per form: check both, record both only when both pass. */
  accept(ip: string, formKey: string, now: number): LimitResult;
}

export function createFormRateLimiter(
  limits: { flood: WindowLimit; ip: WindowLimit; form: WindowLimit } = FORM_RATE_LIMITS,
  maxKeys: number = MAX_TRACKED_KEYS,
): FormRateLimiter {
  const flood = new SlidingWindow(limits.flood, maxKeys);
  const perIp = new SlidingWindow(limits.ip, maxKeys);
  const perForm = new SlidingWindow(limits.form, maxKeys);
  return {
    flood: (ip, now) => flood.hit(ip, now),
    accept(ip, formKey, now) {
      const a = perIp.check(ip, now);
      const b = perForm.check(formKey, now);
      if (!a.ok || !b.ok) {
        return { ok: false, retryAfterSec: Math.max(a.ok ? 0 : a.retryAfterSec, b.ok ? 0 : b.retryAfterSec) };
      }
      perIp.record(ip, now);
      perForm.record(formKey, now);
      return { ok: true };
    },
  };
}

let _limiter: FormRateLimiter | null = null;

export function getFormRateLimiter(): FormRateLimiter {
  if (!_limiter) _limiter = createFormRateLimiter();
  return _limiter;
}

/** Test-only: start from empty windows. */
export function __resetFormRateLimiterForTests(): void {
  _limiter = null;
}

/**
 * The visitor's IP as the proxy in front of the app reports it. The app runs
 * behind the Coolify proxy (and Cloudflare for some hosts), which set these
 * headers; the first hop of X-Forwarded-For is the client. Without a proxy the
 * headers could be forged, which only lets a bot pick its own rate-limit key:
 * the per-form limit still holds. 'unknown' when no header is present.
 */
export function clientIpOf(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const real = headers.get('x-real-ip')?.trim();
  return real || 'unknown';
}
