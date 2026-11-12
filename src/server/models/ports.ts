// src/server/models/ports.ts
//
// The ports of the model store (plan S2): what the upload and the serving code need from storage,
// written as interfaces so the whole flow runs offline against the in-memory fakes in memory.ts.
// The real adapters are GATED, not built here: a Storage Brain client (credentials, the SDK as a
// dependency, live calls) and a Prisma repository on a `site_models` table (a migration that
// `prisma migrate deploy` would run at the next boot). Nothing here reads an environment variable.

/** Bytes by key. Keys are `served/<sha256>` (the re-encoded file) and `original/<sha256>` (kept for one later re-encode, never served). */
export interface ModelBlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export interface SiteModelRecord {
  siteId: string;
  /** sha256 of the re-encoded file. */
  sha256: string;
  bytes: number;
  triangles: number;
  materials: number;
  nodes: number;
  clips: number;
  extensions: string[];
  uploaderId: string;
  createdAt: Date;
  /** Set whenever the same model is uploaded or chosen again, so collection counts age from the last use. */
  lastUsedAt: Date;
  /** The kept original (`original/<sha256>`), never served. */
  originalSha256: string;
  originalBytes: number;
}

export type InsertOutcome = { ok: true } | { ok: false; reason: 'exists' | 'quota' | 'originals-quota' };

/**
 * Metadata, unique on (siteId, sha256). Rows are never edited except `lastUsedAt` (touch).
 * `insertWithinQuota` must be ATOMIC: the totals are read and the row written as one step (a single
 * conditional statement or a per-site lock in the real adapter), because two uploads that each read
 * the total first would both pass.
 */
export interface SiteModelRepository {
  find(siteId: string, sha256: string): Promise<SiteModelRecord | null>;
  insertWithinQuota(record: SiteModelRecord, limits: { servedBytes: number; originalBytes: number }): Promise<InsertOutcome>;
  touch(siteId: string, sha256: string, at: Date): Promise<void>;
  totalBytes(siteId: string): Promise<number>;
  list(siteId: string): Promise<SiteModelRecord[]>;
  delete(siteId: string, sha256: string): Promise<void>;
}

/** What a decoder measured. Reported by the (gated) validator and re-encoder, enforced by the upload code. */
export interface DecodedStats {
  triangles: number;
  /** The longest side of any texture, in pixels. */
  maxTextureSide: number;
  /** The size of the bounding box on each axis, in scene units. */
  boundingBox: [number, number, number];
  materials: number;
  nodes: number;
  clips: number;
}

/** Thrown by a re-encoder for a model it refuses on purpose (too large once decoded, not decodable). The upload answers with its status and message. */
export class ModelRefusalError extends Error {
  constructor(readonly code: string, message: string, readonly status: 413 | 422 | 500 | 503 = 413) {
    super(message);
    this.name = 'ModelRefusalError';
  }
}

/** Step 2: the Khronos glTF validator. Gated: its dependency is not added here. */
export interface ModelValidator {
  validate(bytes: Uint8Array): Promise<{ ok: true } | { ok: false; message: string }>;
}

/** Steps 5 and 6: decode, measure, dedupe, resize textures, compress with meshopt. Gated: glTF-Transform is not added here. */
export interface ModelReencoder {
  reencode(bytes: Uint8Array): Promise<{ bytes: Uint8Array; input: DecodedStats; output: DecodedStats }>;
}
