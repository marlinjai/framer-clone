// In-memory fakes of the model store ports, for tests and local development only.
//
// `MemorySiteModels` is also the reference implementation of `ModelCoordinator` (coordination.ts): each method below is
// one atomic step (no await between its read and its write), which is what the Postgres implementation gets from a
// transaction under a per-key lock at READ COMMITTED.

import type { BeginDeleteOutcome, BeginUploadOutcome, ModelCoordinator } from './coordination';
import type { InsertOutcome, ModelBlobStore, SiteModelRecord, SiteModelRepository } from './ports';

export class MemoryBlobStore implements ModelBlobStore {
  readonly files = new Map<string, Uint8Array>();
  /** When a key was last written, for the orphan sweep. */
  readonly written = new Map<string, Date>();
  async put(key: string, bytes: Uint8Array) { this.files.set(key, bytes.slice()); this.written.set(key, new Date()); }
  async get(key: string) { const b = this.files.get(key); return b ? b.slice() : null; }
  async has(key: string) { return this.files.has(key); }
  async delete(key: string) { this.files.delete(key); this.written.delete(key); }
  async list(prefix: string) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, createdAt: this.written.get(key) ?? new Date(0) })); }
}

interface PendingMeta { attempt: string; pendingUntil: Date }
interface Tombstone { attempt: string; expiresAt: Date }

export class MemorySiteModels implements SiteModelRepository, ModelCoordinator {
  /** Every row, ready or pending. */
  readonly rows = new Map<string, SiteModelRecord>();
  /** Rows that are still pending; a row absent here is ready. */
  readonly pending = new Map<string, PendingMeta>();
  readonly tombstones = new Map<string, Tombstone>();
  private key = (siteId: string, sha: string) => `${siteId}/${sha}`;
  private isReady = (k: string) => this.rows.has(k) && !this.pending.has(k);

  // ---- the repository (ready rows only are visible; a pending row counts toward the quota) ----
  async find(siteId: string, sha256: string) { const k = this.key(siteId, sha256); return this.isReady(k) ? this.rows.get(k) ?? null : null; }

  private quota(record: SiteModelRecord, limits: { servedBytes: number; originalBytes: number }): InsertOutcome {
    const mine = [...this.rows.values()].filter((r) => r.siteId === record.siteId);
    if (mine.reduce((a, r) => a + r.bytes, 0) + record.bytes > limits.servedBytes) return { ok: false, reason: 'quota' };
    const heldOriginals = new Map(mine.map((r) => [r.originalSha256, r.originalBytes]));
    if (!heldOriginals.has(record.originalSha256) && [...heldOriginals.values()].reduce((a, n) => a + n, 0) + record.originalBytes > limits.originalBytes) return { ok: false, reason: 'originals-quota' };
    return { ok: true };
  }

  async insertWithinQuota(record: SiteModelRecord, limits: { servedBytes: number; originalBytes: number }): Promise<InsertOutcome> {
    // Synchronous between the read and the write: atomic, as the port requires.
    const k = this.key(record.siteId, record.sha256);
    if (this.rows.has(k)) return { ok: false, reason: 'exists' };
    const q = this.quota(record, limits);
    if (!q.ok) return q;
    this.rows.set(k, { ...record });
    return { ok: true };
  }
  async touch(siteId: string, sha256: string, at: Date) {
    const k = this.key(siteId, sha256);
    const row = this.isReady(k) ? this.rows.get(k) : undefined;
    if (row) row.lastUsedAt = at;
  }
  async totalBytes(siteId: string) { return [...this.rows.values()].filter((r) => r.siteId === siteId).reduce((a, r) => a + r.bytes, 0); }
  async list(siteId: string) { return [...this.rows.values()].filter((r) => r.siteId === siteId && this.isReady(this.key(r.siteId, r.sha256))); }
  async delete(siteId: string, sha256: string) { const k = this.key(siteId, sha256); this.rows.delete(k); this.pending.delete(k); }

  // ---- the coordinator (each method one atomic step) ----
  private references(key: string): number {
    let n = 0;
    for (const r of this.rows.values()) if (key === `served/${r.sha256}` || key === `original/${r.originalSha256}`) n++;
    return n;
  }

  async beginUpload({ record, limits, attempt, now, pendingTtlMs }: Parameters<ModelCoordinator['beginUpload']>[0]): Promise<BeginUploadOutcome> {
    if (this.tombstones.has(`served/${record.sha256}`) || this.tombstones.has(`original/${record.originalSha256}`)) return { ok: false, reason: 'busy' };
    const k = this.key(record.siteId, record.sha256);
    const until = new Date(now.getTime() + pendingTtlMs);
    if (this.rows.has(k)) {
      const p = this.pending.get(k);
      if (!p) return { ok: false, reason: 'exists' };
      if (p.pendingUntil.getTime() > now.getTime()) return { ok: false, reason: 'in-progress' };
      this.pending.set(k, { attempt, pendingUntil: until });
      return { ok: true, attempt, takenOver: true };
    }
    const q = this.quota(record, limits);
    if (!q.ok) return q;
    this.rows.set(k, { ...record });
    this.pending.set(k, { attempt, pendingUntil: until });
    return { ok: true, attempt, takenOver: false };
  }
  async markReady(siteId: string, sha256: string, attempt: string, at: Date) {
    const k = this.key(siteId, sha256);
    const p = this.pending.get(k);
    if (!p || p.attempt !== attempt || !this.rows.has(k)) return false;
    this.pending.delete(k);
    this.rows.get(k)!.lastUsedAt = at;
    return true;
  }
  async abandonUpload(siteId: string, sha256: string, attempt: string) {
    const k = this.key(siteId, sha256);
    const p = this.pending.get(k);
    if (!p || p.attempt !== attempt) return false;
    this.pending.delete(k);
    this.rows.delete(k);
    return true;
  }
  async beginDelete({ key, attempt, now, leaseMs }: Parameters<ModelCoordinator['beginDelete']>[0]): Promise<BeginDeleteOutcome> {
    if (this.references(key) > 0) return { kind: 'kept', reason: 'referenced' };
    const t = this.tombstones.get(key);
    if (t && t.expiresAt.getTime() > now.getTime()) return { kind: 'busy' };
    this.tombstones.set(key, { attempt, expiresAt: new Date(now.getTime() + leaseMs) });
    return { kind: 'started', attempt, resumed: Boolean(t) };
  }
  async completeDelete(key: string, attempt: string) {
    const t = this.tombstones.get(key);
    if (!t || t.attempt !== attempt) return false;
    this.tombstones.delete(key);
    return true;
  }
  async expiredTombstones(now: Date, limit: number) {
    return [...this.tombstones.entries()].filter(([, t]) => t.expiresAt.getTime() <= now.getTime()).sort((a, b) => a[1].expiresAt.getTime() - b[1].expiresAt.getTime()).slice(0, limit).map(([k]) => k);
  }
  async reapPendingUploads(now: Date, limit: number) {
    const gone: { siteId: string; sha256: string }[] = [];
    for (const [k, p] of [...this.pending.entries()]) {
      if (gone.length >= limit) break;
      if (p.pendingUntil.getTime() > now.getTime()) continue;
      const row = this.rows.get(k);
      this.pending.delete(k);
      this.rows.delete(k);
      if (row) gone.push({ siteId: row.siteId, sha256: row.sha256 });
    }
    return gone;
  }
}
