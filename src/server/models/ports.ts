// src/server/models/ports.ts
//
// The ports of the model store (plan S2): what the upload and the serving code need from storage,
// written as interfaces so the whole flow runs offline against the in-memory fakes in memory.ts.
// The Prisma repository (prismaModels.ts, on the `site_models` table) exists but nothing constructs it; the
// Storage Brain adapter (credentials, the SDK as a dependency, live calls) is GATED and not built. The
// migration is applied by the next deployment's boot (`prisma migrate deploy`) and needs its own authorization.
// Nothing here reads an environment variable.

/** Bytes by key. Keys are `served/<sha256>` (the re-encoded file) and `original/<sha256>` (kept for one later re-encode, never served). */
export interface ModelBlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Every key under a prefix with when it was written, for the orphan sweep (collect.ts). */
  list(prefix: string): Promise<{ key: string; createdAt: Date }[]>;
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
  textures: number;
  extensions: string[];
  /** The material and node names the role panel lists (bounded by the structure caps, each at most 80 characters). */
  materialNames: string[];
  nodeNames: string[];
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
 * Rows are created and promoted only through `ModelCoordinator` (coordination.ts), whose steps are atomic; find, list and
 * touch see READY rows only, totalBytes counts pending rows too.
 */
export interface SiteModelRepository {
  find(siteId: string, sha256: string): Promise<SiteModelRecord | null>;
  // Rows are created ONLY by `ModelCoordinator.beginUpload` (coordination.ts): a direct insert would skip the tombstone check.
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
  textures: number;
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
  reencode(bytes: Uint8Array): Promise<{ bytes: Uint8Array; input: DecodedStats; output: DecodedStats; names: { materials: string[]; nodes: string[] } }>;
}
