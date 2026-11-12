// In-memory fakes of the model store ports, for tests and local development only.

import type { InsertOutcome, ModelBlobStore, SiteModelRecord, SiteModelRepository } from './ports';

export class MemoryBlobStore implements ModelBlobStore {
  readonly files = new Map<string, Uint8Array>();
  readonly written = new Map<string, Date>();
  async put(key: string, bytes: Uint8Array) { this.files.set(key, bytes.slice()); this.written.set(key, new Date()); }
  async list(prefix: string) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, createdAt: this.written.get(key) ?? new Date(0) })); }
  async get(key: string) { const b = this.files.get(key); return b ? b.slice() : null; }
  async has(key: string) { return this.files.has(key); }
  async delete(key: string) { this.files.delete(key); this.written.delete(key); }
}

export class MemorySiteModels implements SiteModelRepository {
  readonly rows = new Map<string, SiteModelRecord>();
  private key = (siteId: string, sha: string) => `${siteId}/${sha}`;
  async find(siteId: string, sha256: string) { return this.rows.get(this.key(siteId, sha256)) ?? null; }
  async insertWithinQuota(record: SiteModelRecord, limits: { servedBytes: number; originalBytes: number }): Promise<InsertOutcome> {
    // Synchronous between the read and the write: atomic, as the port requires.
    const k = this.key(record.siteId, record.sha256);
    if (this.rows.has(k)) return { ok: false, reason: 'exists' };
    const mine = [...this.rows.values()].filter((r) => r.siteId === record.siteId);
    if (mine.reduce((a, r) => a + r.bytes, 0) + record.bytes > limits.servedBytes) return { ok: false, reason: 'quota' };
    const heldOriginals = new Map(mine.map((r) => [r.originalSha256, r.originalBytes]));
    if (!heldOriginals.has(record.originalSha256) && [...heldOriginals.values()].reduce((a, n) => a + n, 0) + record.originalBytes > limits.originalBytes) return { ok: false, reason: 'originals-quota' };
    this.rows.set(k, { ...record });
    return { ok: true };
  }
  async touch(siteId: string, sha256: string, at: Date) {
    const row = this.rows.get(this.key(siteId, sha256));
    if (row) row.lastUsedAt = at;
  }
  async totalBytes(siteId: string) { return [...this.rows.values()].filter((r) => r.siteId === siteId).reduce((a, r) => a + r.bytes, 0); }
  async list(siteId: string) { return [...this.rows.values()].filter((r) => r.siteId === siteId); }
  async delete(siteId: string, sha256: string) { this.rows.delete(this.key(siteId, sha256)); }
}
