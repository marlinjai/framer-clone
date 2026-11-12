// src/server/models/coordination.ts
//
// The upload and blob-cleanup coordination protocol of the 3D plan ("Coordinating uploads and blob cleanup", Option B,
// APPROVED 2026-11-12). It makes one thing true: a blob is never deleted while a row that references it can commit.
// Without it a cleanup that counted zero references can delete a blob another site's upload has just made referenced.
//
// THE PROTOCOL. The order of an upload and of a cleanup is decided in SHORT database steps that hold no lock across
// storage I/O; the storage calls happen between them.
//
//   upload  1. beginUpload   one atomic step: refuse (busy) if a tombstone exists for the served or the original key,
//                            whether it is expired or not; otherwise insert the row as PENDING with this attempt's token and
//                            a deadline (the quota is checked here, pending rows count)
//           2. put the blobs (always rewritten, as before)
//           3. markReady     promote the row to READY, but only if it is still THIS attempt's pending row (fencing)
//   cleanup 0. snapshot      list the copies of the blob that exist NOW (before any tombstone exists)
//           1. beginDelete   one atomic step: keep the blob if ANY row of ANY site, pending or ready, references it;
//                            otherwise write a tombstone with this attempt's token and a lease
//           2. remove exactly the snapshot's copies, then verify the blob is gone
//           3. completeDelete clear the tombstone, but only if it is still THIS attempt's
//
// WHY IT HOLDS. Step 1 of both sides takes the same per-key lock inside one transaction, so the two step 1s are totally
// ordered. If the upload's comes first its pending row exists before it puts anything, so the cleanup counts it and keeps
// the blob. If the cleanup's comes first the tombstone exists, so the upload is refused until it is cleared, and its next
// attempt re-puts the bytes after the delete has been verified. A row is never served until READY (serving ignores
// pending rows), and a pending row's blobs are never assumed present.
//
// FAILURE BIAS: KEEP. A crash can only leave an unreferenced blob (a leak), never a row without a blob:
//   - an uploader that dies after step 1 leaves a pending row; `reapPendingUploads` deletes it once its deadline passes
//     (until then it counts as a reference, so its blobs are kept);
//   - a cleaner that dies after its tombstone leaves one; `reconcileTombstones` takes it over after the lease, deletes
//     again (idempotent) and clears it. An EXPIRED tombstone still blocks uploads: expiry only lets a reconciler take over,
//     so a slow or timed-out storage delete can never land under a fresh upload;
//   - a storage delete that fails or whose result cannot be verified leaves the tombstone in place; the cleanup reports
//     `retry` and is repeated; an unreadable state anywhere means do not delete.
//
// A CLEANER THAT STALLS (a frozen process, a suspended machine) can resume long after its lease passed, after another
// cleaner took over, finished and an upload put a fresh copy. Lease arithmetic cannot close that (a pause can fall between
// any check and the next call), so the protocol closes it at the data: a cleaner removes ONLY the copies it listed BEFORE
// it wrote its tombstone. Such a copy cannot belong to an upload that started after the tombstone (that upload is blocked
// until the tombstone is gone), and one that belongs to an upload that started before it has a pending row, so the
// cleanup would have been refused. A stale cleaner therefore deletes at most what was already doomed, never a later copy.
// This needs a store whose copies have identities (Storage Brain: server-assigned file ids; a delete names ids, never a
// key). A store that deletes by key would still be exposed to a stale cleaner; it would need the lease rule below plus a
// fencing check at the store, which Storage Brain does not offer.
//
// LEASE RULE. A takeover must not overlap a live attempt in the normal case, and a delete that times out at the caller
// can still land at the service. The lease therefore has to be longer than the longest a single blob delete can take, and
// the executor refuses a configuration whose lease is not (`assertLeaseCoversDelete`).
//
// ISOLATION AND LOCK ORDER. Every database step of a real implementation must run at READ COMMITTED (never REPEATABLE
// READ or SERIALIZABLE snapshots that predate the lock wait). `beginUpload` takes the SITE lock first (the quota is a
// sum over the site's rows: two uploads of different content for one site must not both read the old total), then the
// served and original key locks in sorted order; `beginDelete` takes only its key lock. One order, so no deadlock.
// Pinned in the Postgres implementation and tested with concurrent connections; the in-memory implementation's steps
// are atomic by construction.
//
// ROWS ARE CREATED ONLY BY `beginUpload`. There is no other way to insert a model row (a direct insert would skip the
// tombstone check and could reference a blob under a live tombstone).
//
// Nothing here is wired to a route, a job or a setting. The Postgres implementation of `ModelCoordinator` needs a
// migration and is gated separately; uploads and cleanup stay disabled.

import type { InsertOutcome, SiteModelRecord } from './ports';

/** Longer than an upload takes, but short: a crashed upload blocks an identical retry and holds quota until this passes. A live upload reaped early is safe (its promotion is fenced and answers 503 to retry). */
export const PENDING_TTL_MS = 5 * 60_000;
/** Longer than one blob delete can take (a listing of every page plus up to 3 attempts of 30 s per delete, with back-off). */
export const TOMBSTONE_LEASE_MS = 10 * 60_000;
/** The adapter's per-request timeout and attempt count, the upper bound `assertLeaseCoversDelete` checks the lease against. */
export const STORAGE_REQUEST_TIMEOUT_MS = 30_000;
export const STORAGE_REQUEST_ATTEMPTS = 3;

export type BeginUploadOutcome =
  | { ok: true; attempt: string; takenOver: boolean }
  | Exclude<InsertOutcome, { ok: true }>
  /** A tombstone exists for a key of this upload (expired or not): retry later. */
  | { ok: false; reason: 'busy' }
  /** The same site's identical upload is pending and its deadline has not passed: wait and retry. */
  | { ok: false; reason: 'in-progress' };

export type BeginDeleteOutcome =
  | { kind: 'kept'; reason: 'referenced' }
  /** Another cleanup holds an unexpired tombstone: it will delete the blob (and a reconciler finishes it if it dies). */
  | { kind: 'busy' }
  | { kind: 'started'; attempt: string; resumed: boolean };

export interface ModelCoordinator {
  /** Step 1 of an upload (see the header). `attempt` is a fresh random token chosen by the caller. */
  beginUpload(input: {
    record: SiteModelRecord;
    limits: { servedBytes: number; originalBytes: number };
    attempt: string;
    now: Date;
    pendingTtlMs: number;
  }): Promise<BeginUploadOutcome>;
  /** Step 3: true only if the row is still this attempt's pending row (a reaped or taken-over row is not promoted). */
  markReady(siteId: string, sha256: string, attempt: string, at: Date): Promise<boolean>;
  /** Drops this attempt's pending row after a failed put, so the quota is freed; false if it is no longer this attempt's. */
  abandonUpload(siteId: string, sha256: string, attempt: string): Promise<boolean>;
  /** Step 1 of a cleanup of one blob key (`served/<hash>` or `original/<hash>`). */
  beginDelete(input: { key: string; attempt: string; now: Date; leaseMs: number }): Promise<BeginDeleteOutcome>;
  /** Step 3: true if it cleared this attempt's tombstone; false if the tombstone is gone or another attempt's. */
  completeDelete(key: string, attempt: string): Promise<boolean>;
  /** Tombstones whose lease has passed (a crashed or timed-out cleanup), oldest first. */
  expiredTombstones(now: Date, limit: number): Promise<string[]>;
  /** Pending rows past their deadline, removed. Returns what was removed. */
  reapPendingUploads(now: Date, limit: number): Promise<{ siteId: string; sha256: string }[]>;
}

/** The storage calls a cleanup needs. `deleteBlob` removes every copy and a missing key is not an error; `has` says one is listed. */
export interface BlobDeleter {
  /** The copies of the key that exist now (opaque identities, e.g. file ids). Taken BEFORE the tombstone is written. */
  snapshot(key: string): Promise<unknown>;
  /** Removes exactly the copies of `snapshot`, never a copy created after it; a copy already gone is not an error. */
  removeSnapshot(key: string, snapshot: unknown): Promise<void>;
  hasBlob(key: string): Promise<boolean>;
}

export function assertLeaseCoversDelete(leaseMs: number, requestTimeoutMs = STORAGE_REQUEST_TIMEOUT_MS, attempts = STORAGE_REQUEST_ATTEMPTS): void {
  // One delete is a listing plus up to `attempts` timed-out requests per file; require room for four such passes.
  const worst = requestTimeoutMs * attempts * 4;
  if (!(leaseMs > worst)) throw new Error(`tombstone lease ${leaseMs} ms must exceed the longest blob delete (${worst} ms)`);
}

export interface BlobDeletionReport {
  deleted: string[];
  /** Kept because a row references it, or another cleanup finished or owns it (`superseded`). Needs no retry. */
  kept: { key: string; reason: 'referenced' | 'superseded' }[];
  /**
   * The key must be cleaned again; the erasure must not be marked processed. `busy` is another cleanup's live tombstone:
   * counted as a retry so a company erasure never completes on the strength of a cleanup that may yet die.
   */
  retry: { key: string; reason: 'busy' | 'delete-failed' | 'still-present' | 'complete-lost' | 'state-unreadable' }[];
  complete: boolean;
}

const randomToken = () => crypto.randomUUID();
const KEY = /^(served|original)\/[0-9a-f]{64}$/;

async function runDelete(key: string, attempt: string, snapshot: unknown, deps: { coordinator: ModelCoordinator; storage: BlobDeleter }, report: BlobDeletionReport) {
  try {
    await deps.storage.removeSnapshot(key, snapshot);
  } catch {
    report.retry.push({ key, reason: 'delete-failed' });
    return;
  }
  let present: boolean;
  try {
    present = await deps.storage.hasBlob(key);
  } catch {
    report.retry.push({ key, reason: 'still-present' });
    return;
  }
  if (present) { report.retry.push({ key, reason: 'still-present' }); return; }
  try {
    if (await deps.coordinator.completeDelete(key, attempt)) report.deleted.push(key);
    // The tombstone is no longer ours: a takeover finished this cleanup (or is running it). Nothing for us to retry.
    else report.kept.push({ key, reason: 'superseded' });
  } catch {
    report.retry.push({ key, reason: 'complete-lost' });
  }
}

/**
 * Cleans the given blob keys under the protocol. Never throws for one key; `complete` is true only when every key was
 * deleted and verified gone or is held by a row or another cleanup. A key outside the store's namespaces is refused.
 */
export async function deleteBlobsCoordinated(
  keys: readonly string[],
  deps: { coordinator: ModelCoordinator; storage: BlobDeleter; now?: () => Date; leaseMs?: number },
): Promise<BlobDeletionReport> {
  const leaseMs = deps.leaseMs ?? TOMBSTONE_LEASE_MS;
  assertLeaseCoversDelete(leaseMs);
  const report: BlobDeletionReport = { deleted: [], kept: [], retry: [], complete: true };
  for (const key of keys) {
    if (!KEY.test(key)) { report.retry.push({ key, reason: 'state-unreadable' }); continue; }
    // Step 0: the copies that exist before any tombstone does (see "A CLEANER THAT STALLS").
    let snapshot: unknown;
    try {
      snapshot = await deps.storage.snapshot(key);
    } catch {
      report.retry.push({ key, reason: 'state-unreadable' });
      continue;
    }
    const attempt = randomToken();
    let begin: BeginDeleteOutcome;
    try {
      begin = await deps.coordinator.beginDelete({ key, attempt, now: (deps.now ?? (() => new Date()))(), leaseMs });
    } catch {
      report.retry.push({ key, reason: 'state-unreadable' });
      continue;
    }
    if (begin.kind === 'kept') { report.kept.push({ key, reason: 'referenced' }); continue; }
    if (begin.kind === 'busy') { report.retry.push({ key, reason: 'busy' }); continue; }
    await runDelete(key, begin.attempt, snapshot, deps, report);
  }
  report.complete = report.retry.length === 0;
  return report;
}

/** Takes over cleanups that died or timed out (tombstones past their lease) and finishes them. */
export async function reconcileTombstones(
  deps: { coordinator: ModelCoordinator; storage: BlobDeleter; now?: () => Date; leaseMs?: number; limit?: number },
): Promise<BlobDeletionReport> {
  const now = (deps.now ?? (() => new Date()))();
  const keys = await deps.coordinator.expiredTombstones(now, deps.limit ?? 100);
  return deleteBlobsCoordinated(keys, deps);
}
