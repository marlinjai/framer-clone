// src/server/models/erasure.ts
//
// The model blobs of a company erasure (plan docs/plans/2026-11-02-3d-scene-primitive.md, "Storage"). OFFLINE and
// WIRED TO NOTHING: no route, no `eraseCompany` step and no storage client constructs or calls it. It is the pure
// planner and the guarded executor the gated live half will use, tested against fakes.
//
// Why a capture is needed. `site_models` rows are deleted WITH their site (ON DELETE CASCADE), and the blob keys
// live only in those rows. Once the company's sites are gone nothing says which blobs they held. So the erasure
// must, in this order:
//   1. read the hashes the company's sites hold (`captureSiteModelHashes`, rows of the erased sites only),
//   2. store them on the ledger row's scope BEFORE deleting anything (a retry after a partial failure still knows them),
//   3. delete the site rows (cascades the model rows),
//   4. plan (`planCompanyModelErasure`) with the rows that STILL exist across ALL other sites, and execute
//      (`executeModelBlobErasure`), which re-checks each blob right before deleting it,
//   5. mark the erasure processed only if the executor reports no failure and no unknown (a retry is then safe: every
//      step is idempotent, a blob already gone is not an error).
// Blobs are content-addressed and shared across sites and companies, so a blob goes only when no remaining row of any
// site keeps it. Originals are user content and go with the company, by the same rule.

/** The hashes (served and original) the erased sites held, captured before their rows are deleted. */
export interface CapturedModelHashes {
  served: string[];
  originals: string[];
}

const HASH = /^[0-9a-f]{64}$/;

/** Distinct, valid, sorted hashes of the rows of the erased sites. A malformed value is dropped: it names no blob of ours. */
export function captureSiteModelHashes(rows: readonly { sha256: string; originalSha256: string }[]): CapturedModelHashes {
  const uniq = (values: string[]) => [...new Set(values.filter((v) => HASH.test(v)))].sort();
  return { served: uniq(rows.map((r) => r.sha256)), originals: uniq(rows.map((r) => r.originalSha256)) };
}

/** Union of two captures (a retry merges what the first attempt stored with what is found now). */
export function mergeCaptured(a: CapturedModelHashes, b: CapturedModelHashes): CapturedModelHashes {
  return captureSiteModelHashes([
    ...a.served.map((sha256) => ({ sha256, originalSha256: '' })),
    ...b.served.map((sha256) => ({ sha256, originalSha256: '' })),
    ...a.originals.map((originalSha256) => ({ sha256: '', originalSha256 })),
    ...b.originals.map((originalSha256) => ({ sha256: '', originalSha256 })),
  ]);
}

/** Parse what the ledger stored, defensively: anything not shaped like a capture is an empty one. */
export function parseCaptured(value: unknown): CapturedModelHashes {
  const v = (value ?? {}) as { served?: unknown; originals?: unknown };
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
  return { served: captureSiteModelHashes(strings(v.served).map((s) => ({ sha256: s, originalSha256: '' }))).served, originals: captureSiteModelHashes(strings(v.originals).map((s) => ({ sha256: '', originalSha256: s }))).originals };
}

export interface ModelErasureInput {
  captured: CapturedModelHashes;
  /**
   * Rows per hash that remain across ALL sites (the erased sites' rows are already gone), from the repository.
   * A hash missing from the map has an UNKNOWN count and is kept: nothing is deleted on a guess.
   */
  remainingServed: ReadonlyMap<string, number>;
  remainingOriginals: ReadonlyMap<string, number>;
}

export interface ModelErasurePlan {
  /** Blob keys (`served/<hash>`, `original/<hash>`) no remaining row keeps. */
  keys: string[];
  /** Hashes kept because a row still holds them, or because their count is unknown. */
  kept: { key: string; reason: 'held' | 'unknown' }[];
}

export function planCompanyModelErasure({ captured, remainingServed, remainingOriginals }: ModelErasureInput): ModelErasurePlan {
  const plan: ModelErasurePlan = { keys: [], kept: [] };
  const decide = (prefix: 'served' | 'original', hashes: string[], remaining: ReadonlyMap<string, number>) => {
    for (const hash of hashes) {
      const key = `${prefix}/${hash}`;
      const n = remaining.get(hash);
      if (n === undefined || !Number.isFinite(n) || n < 0) plan.kept.push({ key, reason: 'unknown' });
      else if (n > 0) plan.kept.push({ key, reason: 'held' });
      else plan.keys.push(key);
    }
  };
  decide('served', captured.served.filter((h) => HASH.test(h)), remainingServed);
  decide('original', captured.originals.filter((h) => HASH.test(h)), remainingOriginals);
  return plan;
}

export interface ModelErasureExecutorPorts {
  /** Rows that reference the blob key right now, across ALL sites; `null` when it cannot be told. Never cached. */
  rowsReferencing(key: string): Promise<number | null>;
  /** Deleting a key that is already gone is not an error. */
  deleteBlob(key: string): Promise<void>;
}

export interface ModelErasureReport {
  deleted: string[];
  /** A row appeared since the plan (an upload of the same content), or the count could not be read. */
  skipped: { key: string; reason: 'held-now' | 'unknown' }[];
  failed: { key: string; error: string }[];
  /** True only when every planned key was deleted or is provably held by another row: the erasure may be marked processed. */
  complete: boolean;
}

/**
 * Deletes the planned keys one by one, re-checking for a row immediately before each delete (an upload may have added
 * one since the plan). It never throws for one key: the rest still run, and `complete` is false when anything failed or
 * could not be checked, so the caller leaves the erasure unprocessed and auth-brain retries. A key outside the store's
 * own namespaces is refused, whatever the plan says.
 */
export async function executeModelBlobErasure(plan: ModelErasurePlan, ports: ModelErasureExecutorPorts): Promise<ModelErasureReport> {
  const report: ModelErasureReport = { deleted: [], skipped: [], failed: [], complete: true };
  for (const key of plan.keys) {
    if (!/^(served|original)\/[0-9a-f]{64}$/.test(key)) {
      report.failed.push({ key, error: 'key outside the model store namespaces' });
      continue;
    }
    let rows: number | null;
    try {
      rows = await ports.rowsReferencing(key);
    } catch {
      rows = null;
    }
    if (rows === null) { report.skipped.push({ key, reason: 'unknown' }); continue; }
    if (rows > 0) { report.skipped.push({ key, reason: 'held-now' }); continue; }
    try {
      await ports.deleteBlob(key);
      report.deleted.push(key);
    } catch (err) {
      // Name only: a storage error may quote a path or a token.
      report.failed.push({ key, error: err instanceof Error ? err.name : 'unknown error' });
    }
  }
  report.complete = report.failed.length === 0 && !report.skipped.some((s) => s.reason === 'unknown') && !plan.kept.some((k) => k.reason === 'unknown');
  return report;
}
