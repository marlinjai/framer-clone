// src/server/models/storage/storageBrain.ts
//
// The Storage Brain adapter of the model store's blob port (ports.ts ModelBlobStore), offline: it takes an injected
// `fetch` and a config object (base address, API key) and reads no environment variable, constructs nothing on its own
// and is wired to no route. Written against the service's own route source
// (projects/lumitra-infra/storage-brain/packages/api/src/routes/{upload,files,internal-upload}.ts); the first real call
// is gated (it needs a key Marlin places, and an answer to the namespace question in the plan).
//
// THE SERVICE'S SHAPE, which drives every safety rule below:
//   - A file has a server-assigned id, never a caller's key, so a blob key is stored as the file's `context` label
//     (an exact-match filter) under this adapter's namespace, with an ownership tag.
//   - An upload is a handshake that already creates (and reserves quota for) a file row, then a separate PUT. A row exists,
//     listed, before and without its bytes ("pending", or "failed" after a cut-off). Only `completed` rows are blobs.
//   - Nothing makes a context unique: two uploads of one key are two files.
//   - The tenant is the API key's, and may be SHARED with other applications (an open question recorded in the plan). Every
//     rule therefore assumes files that are not ours can sit in the same tenant, even under a similar context.
//   - A list page is cut by a millisecond timestamp (`created_at < cursor`): files with the same timestamp at a page
//     boundary are skipped. The first page's `total` lets us notice.
//   - `DELETE` removes whatever id it is given within the tenant; it checks nothing about whose file it is.
//
// RULES (each tested against a fake written from the source, in __tests__/storageBrain.test.ts):
//   1. Content addressing is verified, never trusted: a key's hash is the sha256 of its bytes. `put` refuses bytes that do
//      not hash to the key; `get` returns bytes only after their sha256 matches, trying the next candidate otherwise.
//   2. A candidate is a file whose context is EXACTLY `<namespace>/<key>`, carrying our ownership tag, of the model type,
//      `completed`, and non empty. Anything else is not ours and never read or deleted.
//   3. DELETE ON AMBIGUITY REFUSES. Removal is two steps, `snapshot(key)` then `removeSnapshot(key, snapshot)` (the cleanup
//      protocol of coordination.ts takes the snapshot BEFORE its tombstone, so a stalled cleaner can only remove copies that
//      already existed). Before a snapshot the listing must be complete and unambiguous: every page followed to the end, the
//      number of files seen equal to the first page's `total`, no file with our exact context that lacks our tag (a
//      stranger's, or ours from an older convention), no inconsistent answer. Otherwise nothing is snapshotted and an
//      `ambiguous` error is thrown. A removal only ever names ids of a snapshot this adapter took (never an id from a
//      caller) and removes only candidates; in-flight (`pending`) rows are left to the service, they may belong to a
//      running upload. There is no delete-by-key method: every removal goes through the protocol.
//   4. A failed or partial upload cleans up only what this call created, by the id the handshake returned, and then
//      starts over (at most 2 attempts): the handshake is never blindly retried, because each one reserves quota.
//   5. Retries are for what is safe to repeat (reads, deleting a known id; a 404 on delete counts as done), bounded, with
//      back-off.
//   6. The key travels only as a Bearer header to this one origin. Redirects are never followed (`redirect: 'error'`),
//      the upload address the service returns must be the relative `/_internal/upload/` path (never an absolute address),
//      and the PUT carries no API key (its signed token is in its own query). No error message contains the key or a
//      signed address.
//   7. Every response is parsed strictly and bounded (JSON at most 1 MB, a download at most the declared size and the cap).

// CALLERS must order their own writes, because the adapter cannot lock: write the database row only AFTER `put` returned,
// and delete a blob only through the cleanup protocol (otherwise a `put` that skipped because a copy existed can race a
// removal of that copy). `has` says a complete tagged copy is listed; only `get` and `put` verify bytes. A handshake that
// times out may have created a row nothing here can identify: the service expires unused upload sessions and frees their
// quota, so it is left to it rather than guessed at.

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BlobDeleter } from '../coordination';
import type { ModelBlobStore } from '../ports';

export type StorageBrainErrorCode = 'config' | 'unauthorized' | 'quota' | 'unavailable' | 'bad-response' | 'ambiguous' | 'integrity' | 'invalid-key';

export class StorageBrainError extends Error {
  constructor(readonly code: StorageBrainErrorCode, message: string) {
    super(message);
    this.name = 'StorageBrainError';
  }
}

export interface StorageBrainConfig {
  /** The service's origin, `https://...` (plain `http://` only for a loopback address, for local tests). No path, no credentials. */
  baseUrl: string;
  /** The tenant's API key. Held in a closure, sent as a Bearer header to `baseUrl` only, never logged. */
  apiKey: string;
  /** Prefix of every context this adapter writes or reads. Default `framer-models`. */
  namespace?: string;
  /** Injected for tests. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected for tests (back-off). */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request time limit. Default 30 s (uploads and downloads 120 s). */
  timeoutMs?: number;
  /** The largest blob read or written. Default 50 MB, the upload cap. */
  maxBytes?: number;
}

const KEY = /^(served|original)\/([0-9a-f]{64})$/;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_TYPES = ['model/gltf-binary', 'model/gltf+json'] as const;
const OWNER_TAG = 'owner';
const KEY_TAG = 'blob';
const JSON_LIMIT = 1024 * 1024;
const MAX_PAGES = 20;
const PAGE = 100;
const MAX_CONTEXTS = 10_000;
const API = '/api/v1';
const UPLOAD_PATH = '/_internal/upload/';

interface FileRow { id: string; context: string; tags: Record<string, string> | null; fileType: string; sizeBytes: number; processingStatus: string; createdAt: number }

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What `snapshot` returns: the ids of the copies listed at that moment. Opaque to callers. */
export interface BlobSnapshot { readonly key: string; readonly ids: readonly string[] }

export class StorageBrainBlobStore implements ModelBlobStore, BlobDeleter {
  /** Only a snapshot this adapter produced can be removed (a forged one could name any file id of the tenant). */
  private readonly snapshots = new WeakSet<BlobSnapshot>();
  private readonly base: string;
  private readonly namespace: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly apiKey: string;

  constructor(config: StorageBrainConfig) {
    let url: URL;
    try { url = new URL(config.baseUrl); } catch { throw new StorageBrainError('config', 'the Storage Brain address is not a URL'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new StorageBrainError('config', 'the Storage Brain address must be https (http only for a loopback address)');
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new StorageBrainError('config', 'the Storage Brain address must be an origin: no credentials, path, query or fragment');
    if (typeof config.apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(config.apiKey)) throw new StorageBrainError('config', 'the Storage Brain API key is missing or malformed');
    const namespace = config.namespace ?? 'framer-models';
    if (!NAMESPACE.test(namespace)) throw new StorageBrainError('config', 'the namespace must be 1 to 26 lower-case letters, digits or hyphens');
    // The longest context this adapter writes must fit the service's 100 character limit.
    if (`${namespace}/original/${'0'.repeat(64)}`.length > 100) throw new StorageBrainError('config', 'the namespace is too long for the service\'s context limit');
    this.base = url.origin;
    this.apiKey = config.apiKey;
    this.namespace = namespace;
    this.doFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = config.sleep ?? ((ms) => delay(ms));
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxBytes = config.maxBytes ?? 50 * 1024 * 1024;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The port
  // ---------------------------------------------------------------------------------------------------------------

  /** A complete, tagged copy is LISTED. This does not verify its bytes: `get` does, and `put` verifies before it skips a write. */
  async has(key: string): Promise<boolean> {
    return (await this.candidates(key)).files.length > 0;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const hash = this.parse(key).hash;
    const { files } = await this.candidates(key);
    for (const file of files) {
      let bytes: Uint8Array;
      try { bytes = await this.download(file); } catch (err) {
        // An unreadable candidate is skipped, not fatal: another copy may be good. Unavailable service errors still surface.
        if (err instanceof StorageBrainError && (err.code === 'unavailable' || err.code === 'unauthorized')) throw err;
        continue;
      }
      if (bytes.byteLength === file.sizeBytes && sha256(bytes) === hash) return bytes;
    }
    return null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const { hash, kind } = this.parse(key);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > this.maxBytes) throw new StorageBrainError('invalid-key', 'the blob is empty or over the size cap');
    if (sha256(bytes) !== hash) throw new StorageBrainError('integrity', 'the bytes do not hash to the key');
    // Already stored and verified: nothing to write. (A listed file with the right size but wrong content is not "stored".)
    if (await this.get(key)) return;

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      // The handshake creates (and reserves quota for) a row. If it fails in ANY way we cannot know whether a row was
      // created (a time-out after the service committed), so it is never repeated: a second one could reserve twice.
      // A row we cannot identify is left to the service, which expires unused upload sessions and releases their quota.
      const createdId = await this.handshake(key, kind, hash, bytes.byteLength, bytes);
      try {
        await this.putBytes(createdId, bytes);
        await this.confirm(createdId, bytes.byteLength);
        return;
      } catch (err) {
        lastError = err;
        // Remove only the file THIS call created, by the id the handshake returned. Never a lookup by context.
        try { await this.deleteKnownId(createdId); } catch {
          // Cleanup failed: a row of ours may stay, with its quota. Do not add a second one; say so.
          throw new StorageBrainError('unavailable', 'the upload failed and its half-written file could not be removed');
        }
        if (err instanceof StorageBrainError && (err.code === 'quota' || err.code === 'unauthorized')) throw err;
        if (err instanceof StorageBrainError && err.code === 'bad-response' && !this.stale.has(err)) throw err;
      }
    }
    throw lastError instanceof StorageBrainError ? lastError : new StorageBrainError('unavailable', 'the upload to Storage Brain failed');
  }

  /** `has`, under the name the cleanup protocol's port uses (coordination.ts BlobDeleter). */
  hasBlob(key: string): Promise<boolean> { return this.has(key); }

  /**
   * The copies of a key that exist NOW, as an opaque snapshot for `removeSnapshot`. The cleanup protocol takes it BEFORE it
   * writes its tombstone, so a stalled cleaner that resumes late can only remove copies that already existed, never one a
   * later upload put (a copy has a server-assigned id, and ids are never reused). DELETE ON AMBIGUITY REFUSES: an
   * incomplete or not-clearly-ours listing throws `ambiguous` and nothing is snapshotted.
   */
  async snapshot(key: string): Promise<BlobSnapshot> {
    const found = await this.candidates(key);
    if (found.ambiguous) throw new StorageBrainError('ambiguous', 'the listing for this key is not complete or not clearly ours: nothing will be deleted');
    // Defence in depth: every id snapshotted was just found as an exact, tagged, completed candidate of this key.
    for (const file of found.files) {
      if (file.context !== this.context(key)) throw new StorageBrainError('ambiguous', 'a candidate does not match the key: nothing will be deleted');
    }
    const snap: BlobSnapshot = { key, ids: found.files.map((f) => f.id) };
    this.snapshots.add(snap);
    return snap;
  }

  /** Removes exactly the copies of a snapshot THIS adapter took for this key; an id already gone (404) is done. */
  async removeSnapshot(key: string, snapshot: unknown): Promise<void> {
    if (!this.snapshots.has(snapshot as BlobSnapshot) || (snapshot as BlobSnapshot).key !== key) {
      throw new StorageBrainError('invalid-key', 'removeSnapshot takes a snapshot of this key taken by this adapter');
    }
    for (const id of (snapshot as BlobSnapshot).ids) await this.deleteKnownId(id);
  }

  /** Every blob under a prefix (`served/`, `original/`, or empty) with when it was first written, for the orphan sweep. */
  async list(prefix: string): Promise<{ key: string; createdAt: Date }[]> {
    if (prefix !== '' && prefix !== 'served/' && prefix !== 'original/') throw new StorageBrainError('invalid-key', 'a listing prefix is empty, served/ or original/');
    const body = await this.getJson(`${API}/files/contexts`);
    const contexts = isRecord(body) && Array.isArray(body.contexts) ? body.contexts : null;
    if (!contexts) throw new StorageBrainError('bad-response', 'the context list has no contexts');
    if (contexts.length > MAX_CONTEXTS) throw new StorageBrainError('ambiguous', 'the tenant holds too many contexts to scan');
    const wanted = `${this.namespace}/${prefix}`;
    const out: { key: string; createdAt: Date }[] = [];
    for (const c of contexts) {
      const context = isRecord(c) && typeof c.context === 'string' ? c.context : null;
      if (!context || !context.startsWith(wanted)) continue;
      const key = context.slice(this.namespace.length + 1);
      if (!KEY.test(key)) continue; // not one of our shapes: not ours to report
      const { files } = await this.candidates(key);
      if (files.length) out.push({ key, createdAt: new Date(files[0].createdAt) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------------------------

  private parse(key: string): { kind: 'served' | 'original'; hash: string } {
    const m = typeof key === 'string' ? KEY.exec(key) : null;
    if (!m) throw new StorageBrainError('invalid-key', 'a blob key is served/<sha256> or original/<sha256>');
    return { kind: m[1] as 'served' | 'original', hash: m[2] };
  }

  private context(key: string): string { return `${this.namespace}/${key}`; }

  /** The listing for one key: its candidates oldest first, and whether the picture is complete and unambiguous. */
  private async candidates(key: string): Promise<{ files: FileRow[]; ambiguous: boolean }> {
    this.parse(key);
    const context = this.context(key);
    const seen = new Map<string, FileRow>();
    let cursor: string | null = null;
    let total: number | null = null;
    let ambiguous = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ context, limit: String(PAGE) });
      if (cursor) query.set('cursor', cursor);
      const body = await this.getJson(`${API}/files?${query}`);
      if (!isRecord(body) || !Array.isArray(body.files)) throw new StorageBrainError('bad-response', 'the file list is malformed');
      if (total === null) total = typeof body.total === 'number' && Number.isInteger(body.total) && body.total >= 0 ? body.total : -1;
      for (const raw of body.files) {
        const row = this.row(raw);
        if (!row) { ambiguous = true; continue; }
        if (seen.has(row.id)) { ambiguous = true; continue; }
        seen.set(row.id, row);
      }
      cursor = typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null;
      if (!cursor) break;
      if (page === MAX_PAGES - 1) ambiguous = true;
    }
    // Rows skipped by a timestamp tie at a page boundary show up as a smaller count than the service reported.
    if (total === null || total < 0 || seen.size !== total) ambiguous = true;
    const files: FileRow[] = [];
    for (const row of seen.values()) {
      if (row.context !== context) { ambiguous = true; continue; } // the service filtered by context: anything else is wrong
      const ours = row.tags?.[OWNER_TAG] === this.namespace && row.tags?.[KEY_TAG] === key;
      if (!ours) { ambiguous = true; continue; } // same context, not tagged by us: a stranger's, or an older convention
      if (!(MODEL_TYPES as readonly string[]).includes(row.fileType)) { ambiguous = true; continue; }
      if (row.processingStatus !== 'completed' || row.sizeBytes < 1) continue; // pending or failed: no blob (and not ours to remove)
      files.push(row);
    }
    files.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    return { files, ambiguous };
  }

  private row(raw: unknown): FileRow | null {
    if (!isRecord(raw)) return null;
    const { id, context, tags, fileType, sizeBytes, processingStatus, createdAt } = raw;
    if (typeof id !== 'string' || !UUID.test(id) || typeof context !== 'string' || typeof fileType !== 'string' || typeof processingStatus !== 'string') return null;
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null;
    const created = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
    if (!Number.isFinite(created)) return null;
    let tagMap: Record<string, string> | null = null;
    if (isRecord(tags)) tagMap = Object.fromEntries(Object.entries(tags).filter((e): e is [string, string] => typeof e[1] === 'string'));
    return { id, context, tags: tagMap, fileType, sizeBytes, processingStatus, createdAt: created };
  }

  private uploadPath = new Map<string, string>();
  /** Errors that mean the upload session was no longer usable (expired, already claimed): a fresh handshake is the right answer. */
  private readonly stale = new WeakSet<Error>();

  /** Step one: the handshake, which creates (and reserves quota for) the file row. Returns the id of the row this call created. */
  private async handshake(key: string, kind: 'served' | 'original', hash: string, size: number, bytes: Uint8Array): Promise<string> {
    const fileType = bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46 ? 'model/gltf-binary' : kind === 'served' ? 'model/gltf-binary' : 'model/gltf+json';
    const handshake = await this.json(`${API}/upload/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileType, fileName: `${hash}.${fileType === 'model/gltf-binary' ? 'glb' : 'gltf'}`, fileSizeBytes: size, context: this.context(key), tags: { [OWNER_TAG]: this.namespace, [KEY_TAG]: key } }),
    }, [200, 201]);
    if (!isRecord(handshake) || typeof handshake.fileId !== 'string' || !UUID.test(handshake.fileId)) throw new StorageBrainError('bad-response', 'the upload handshake has no valid file id');
    const fileId = handshake.fileId;
    const presigned = handshake.presignedUrl;
    // Only the service's own relative upload path, in its exact form, for THIS file (never an absolute address, an encoded
    // dot segment, a query injection or a path of another file): the bytes can go nowhere else.
    const wellFormed = new RegExp(`^${UPLOAD_PATH}tenants%2F[A-Za-z0-9_-]{1,64}%2Ffiles%2F${fileId}%2F${hash}\\.(?:glb|gltf)\\?token=[A-Za-z0-9_-]{16,256}&expires=\\d{10,16}$`, 'i');
    let sameOrigin = false;
    try { const u = new URL(`${this.base}${typeof presigned === 'string' ? presigned : ''}`); sameOrigin = u.origin === this.base && u.pathname.startsWith(UPLOAD_PATH) && !/%2e/i.test(u.pathname.slice(UPLOAD_PATH.length).replace(/%2f/gi, '')); } catch { sameOrigin = false; }
    if (typeof presigned !== 'string' || !wellFormed.test(presigned) || !sameOrigin) {
      await this.deleteKnownId(fileId).catch(() => undefined);
      throw new StorageBrainError('bad-response', 'the upload address is not the service\'s own upload path for this file');
    }
    this.uploadPath.set(fileId, presigned);
    return fileId;
  }

  /** Step two: the bytes, to the relative path the handshake returned. The PUT carries no API key: its signed token is in its own query. */
  private async putBytes(fileId: string, bytes: Uint8Array): Promise<void> {
    const presigned = this.uploadPath.get(fileId);
    this.uploadPath.delete(fileId);
    if (!presigned) throw new StorageBrainError('bad-response', 'no upload address for this file');
    const type = bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46 ? 'model/gltf-binary' : 'model/gltf+json';
    const res = await this.request(`${this.base}${presigned}`, { method: 'PUT', headers: { 'content-type': type }, body: bytes as unknown as BodyInit }, false, this.timeoutMs * 4);
    if (!res.ok) {
      const err = await this.fail(res, 'the upload was refused');
      if (res.status === 409 || res.status === 410) this.stale.add(err);
      throw err;
    }
    await res.body?.cancel().catch(() => undefined);
  }

  /** The file is stored only if the service now says so: completed, with exactly the size we sent. */
  private async confirm(fileId: string, size: number): Promise<void> {
    const body = await this.getJson(`${API}/files/${fileId}`);
    const row = this.row(body);
    if (!row || row.id !== fileId || row.processingStatus !== 'completed' || row.sizeBytes !== size) throw new StorageBrainError('unavailable', 'the upload did not complete');
  }

  private async download(file: FileRow): Promise<Uint8Array> {
    if (file.sizeBytes < 1 || file.sizeBytes > this.maxBytes) throw new StorageBrainError('bad-response', 'a stored blob has an impossible size');
    const res = await this.request(`${this.base}${API}/files/${file.id}/download`, { method: 'GET' }, true, this.timeoutMs * 4, true);
    if (!res.ok) throw await this.fail(res, 'the download was refused');
    // A proxy that compresses the answer makes Content-Length the compressed size: then only the size and hash checks below apply.
    const declared = res.headers.get('content-length');
    if (declared !== null && !res.headers.get('content-encoding') && Number(declared) !== file.sizeBytes) { await res.body?.cancel().catch(() => undefined); throw new StorageBrainError('bad-response', 'the download size differs from the stored size'); }
    return this.readLimited(res, file.sizeBytes);
  }

  private async deleteKnownId(id: string): Promise<void> {
    if (!UUID.test(id)) throw new StorageBrainError('invalid-key', 'not a file id');
    const res = await this.request(`${this.base}${API}/files/${id}`, { method: 'DELETE' }, true, this.timeoutMs, true);
    if (res.status === 404) { await res.body?.cancel().catch(() => undefined); return; } // already gone
    if (!res.ok) throw await this.fail(res, 'the delete was refused');
    await res.body?.cancel().catch(() => undefined);
  }

  private async getJson(path: string): Promise<unknown> {
    return this.json(path, { method: 'GET' }, [200], true);
  }

  private async json(path: string, init: RequestInit, ok: number[], retry = false): Promise<unknown> {
    const res = await this.request(`${this.base}${path}`, init, true, this.timeoutMs, retry);
    if (!ok.includes(res.status)) throw await this.fail(res, 'the request was refused');
    const bytes = await this.readLimited(res, JSON_LIMIT);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new StorageBrainError('bad-response', 'the answer is not JSON'); }
  }

  /** Map a refused answer to an error, reading the service's error envelope (bounded) for its code. The body is always consumed. */
  private async fail(res: Response, what: string): Promise<StorageBrainError> {
    let code = '';
    try {
      const raw = await this.readLimited(res, 64 * 1024);
      const body = JSON.parse(new TextDecoder().decode(raw)) as { error?: { code?: unknown } };
      if (typeof body?.error?.code === 'string') code = body.error.code;
    } catch { /* an answer without a readable envelope is classified by its status alone */ }
    const status = res.status;
    // The real service answers an exhausted quota with 403 QUOTA_EXCEEDED, and an oversize body with 413.
    if (code === 'QUOTA_EXCEEDED' || code === 'PAYLOAD_TOO_LARGE' || status === 413 || status === 402 || status === 507) return new StorageBrainError('quota', `Storage Brain's quota or size limit was reached (${status})`);
    if (status === 401 || status === 403) return new StorageBrainError('unauthorized', `Storage Brain refused the credentials (${status})`);
    if (status >= 500 || status === 429 || status === 408) return new StorageBrainError('unavailable', `Storage Brain is not available (${status})`);
    return new StorageBrainError('bad-response', `${what} (${status})`);
  }

  /** Read a body, stopping at `limit` bytes, never buffering more. */
  private async readLimited(res: Response, limit: number): Promise<Uint8Array> {
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      // A reset or a time-out in the middle of a body is the service being unavailable, not an empty or missing file.
      try { step = await reader.read(); } catch { throw new StorageBrainError('unavailable', 'Storage Brain stopped answering part way'); }
      const { done, value } = step;
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => undefined); throw new StorageBrainError('bad-response', 'an answer is larger than allowed'); }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  }

  /**
   * One request: Bearer key (to this origin only), no redirects, a time limit, and, for `retry`, bounded retries of network
   * errors, 429 and 5xx. Never retried when `retry` is false (the upload handshake and PUT).
   */
  private async request(url: string, init: RequestInit, withKey: boolean, timeoutMs: number, retry = false): Promise<Response> {
    const attempts = retry ? 3 : 1;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      const controller = new AbortController();
      // The limit covers the body too, so the timer is not cleared on success; it is unref'd and fires harmlessly later.
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const headers = new Headers(init.headers);
        if (withKey) headers.set('authorization', `Bearer ${this.apiKey}`);
        const res = await this.doFetch(url, { ...init, headers, redirect: 'error', signal: controller.signal });
        if (retry && (res.status === 429 || res.status >= 500) && i < attempts - 1) {
          clearTimeout(timer);
          await res.body?.cancel().catch(() => undefined);
          // The service limits a key to 100 requests a minute: honour Retry-After (at most 65 s), else back off.
          const after = Number(res.headers.get('retry-after'));
          await this.sleep(res.status === 429 && Number.isFinite(after) && after > 0 ? Math.min(after, 65) * 1000 : 200 * 2 ** i);
          continue;
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        last = err;
        if (i < attempts - 1) { await this.sleep(200 * 2 ** i); continue; }
      }
    }
    // Nothing from the error is passed on: it may carry the address with a signed token.
    void last;
    throw new StorageBrainError('unavailable', 'Storage Brain could not be reached');
  }
}
