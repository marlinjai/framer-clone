// services/box/src/rateLimit.ts
//
// A token bucket per key, in memory, with a hard bound on how many keys it
// remembers. When the bound is reached the key used longest ago is forgotten,
// so memory cannot grow with the number of addresses that knock.

export interface RateLimitOptions {
  /** Requests allowed in one window, and the size of a burst. */
  capacity: number;
  /** The window, in milliseconds, over which `capacity` tokens come back. */
  windowMs: number;
  /** How many keys are remembered at most. */
  maxKeys: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {
    if (!(options.capacity >= 1) || !(options.windowMs > 0) || !(options.maxKeys >= 1)) {
      throw new Error('a rate limit needs a capacity, a window and a bound');
    }
  }

  /** Takes one token for the key. False when none is left. */
  take(key: string, now: number): boolean {
    const { capacity, windowMs, maxKeys } = this.options;
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Moved to the end: the map's order is the order of last use.
      this.buckets.delete(key);
      const elapsed = Math.max(0, now - bucket.at);
      bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * capacity) / windowMs);
      bucket.at = now;
    } else {
      bucket = { tokens: capacity, at: now };
      while (this.buckets.size >= maxKeys) {
        const oldest = this.buckets.keys().next();
        if (oldest.done) break;
        this.buckets.delete(oldest.value);
      }
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** How many keys are remembered now. */
  get size(): number {
    return this.buckets.size;
  }
}
