// services/box/src/cache.ts
//
// What the box remembers of a lookup, for 60 seconds, within a byte budget.
// Least recently used goes first. Together with the 300 second HTTP cache
// this bounds how long a disabled block can keep loading at six minutes.

export type CachedLookup =
  | { kind: 'missing' }
  | { kind: 'found'; live: boolean; body: Buffer; frameAncestorHosts: unknown[] };

interface Slot {
  value: CachedLookup;
  bytes: number;
  expires: number;
}

/** What one entry costs beyond its document: the key, the hosts, the map slot. An estimate on the safe side. */
const ENTRY_OVERHEAD_BYTES = 4096;

export class LookupCache {
  private readonly slots = new Map<string, Slot>();
  // Misses are kept apart, bounded by their number: a flood of unknown addresses can push out
  // other misses, never a document.
  private readonly misses = new Map<string, number>();
  private used = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly ttlMs: number,
    private readonly maxMisses = 4096,
  ) {}

  get(key: string, now: number): CachedLookup | undefined {
    const missExpires = this.misses.get(key);
    if (missExpires !== undefined) {
      if (missExpires > now) return { kind: 'missing' };
      this.misses.delete(key);
    }
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    if (slot.expires <= now) {
      this.drop(key, slot);
      return undefined;
    }
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.value;
  }

  set(key: string, value: CachedLookup, now: number): void {
    const existing = this.slots.get(key);
    if (existing) this.drop(key, existing);
    this.misses.delete(key);
    if (value.kind === 'missing') {
      if (this.maxMisses < 1) return;
      while (this.misses.size >= this.maxMisses) {
        const oldest = this.misses.keys().next();
        if (oldest.done) break;
        this.misses.delete(oldest.value);
      }
      this.misses.set(key, now + this.ttlMs);
      return;
    }
    const bytes = ENTRY_OVERHEAD_BYTES + value.body.length;
    if (bytes > this.maxBytes) return;
    while (this.used + bytes > this.maxBytes) {
      const oldest = this.slots.entries().next();
      if (oldest.done) break;
      this.drop(oldest.value[0], oldest.value[1]);
    }
    this.slots.set(key, { value, bytes, expires: now + this.ttlMs });
    this.used += bytes;
  }

  private drop(key: string, slot: Slot): void {
    this.slots.delete(key);
    this.used -= slot.bytes;
  }

  get bytes(): number {
    return this.used;
  }

  get size(): number {
    return this.slots.size;
  }

  get missCount(): number {
    return this.misses.size;
  }
}
