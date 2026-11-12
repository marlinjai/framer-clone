// In-memory fakes of the model store ports, for tests and local development only.

import type { ModelBlobStore, SiteModelRecord, SiteModelRepository } from './ports';

export class MemoryBlobStore implements ModelBlobStore {
  readonly files = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) { this.files.set(key, bytes.slice()); }
  async get(key: string) { const b = this.files.get(key); return b ? b.slice() : null; }
  async has(key: string) { return this.files.has(key); }
  async delete(key: string) { this.files.delete(key); }
}

export class MemorySiteModels implements SiteModelRepository {
  readonly rows = new Map<string, SiteModelRecord>();
  private key = (siteId: string, sha: string) => `${siteId}/${sha}`;
  async find(siteId: string, sha256: string) { return this.rows.get(this.key(siteId, sha256)) ?? null; }
  async insert(record: SiteModelRecord) {
    const k = this.key(record.siteId, record.sha256);
    if (this.rows.has(k)) throw new Error('site model already exists');
    this.rows.set(k, { ...record });
  }
  async totalBytes(siteId: string) { return [...this.rows.values()].filter((r) => r.siteId === siteId).reduce((a, r) => a + r.bytes, 0); }
  async list(siteId: string) { return [...this.rows.values()].filter((r) => r.siteId === siteId); }
  async delete(siteId: string, sha256: string) { this.rows.delete(this.key(siteId, sha256)); }
}
