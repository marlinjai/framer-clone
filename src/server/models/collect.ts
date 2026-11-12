// src/server/models/collect.ts
//
// Which stored models may be collected (plan, "Storage"): a published revision freezes the hashes
// it references, so a model a revision uses is never deleted while that revision is kept; a model
// no kept revision and no draft references is collected AFTER 30 days from its last use (created,
// or uploaded or chosen again). Pure planner: it decides, it deletes nothing.
//
// Blobs are content-addressed and shared across sites, so a blob may go only when no row of ANY
// site keeps it. The caller passes the repository's count of rows per hash across all sites
// (never a page or one site's rows); the executor must re-check for a row immediately before each
// blob delete, since an upload may have added one since the plan was made.

export const COLLECT_AFTER_DAYS = 30;

export interface CollectInput {
  /** Candidate rows (any subset is fine: it is a list of what to consider). */
  models: { siteId: string; sha256: string; originalSha256: string; createdAt: Date; lastUsedAt: Date }[];
  /** `siteId/sha256` of every model any kept revision or any draft of the site references. */
  referenced: ReadonlySet<string>;
  /** Rows per served hash, and per original hash, across ALL sites, from the repository. */
  rowsPerSha: ReadonlyMap<string, number>;
  rowsPerOriginal: ReadonlyMap<string, number>;
  now: Date;
}

export interface CollectionPlan {
  rows: { siteId: string; sha256: string }[];
  /** Served blobs (`served/<hash>`) no remaining row keeps. */
  blobs: string[];
  /** Originals (`original/<hash>`) no remaining row keeps. */
  originals: string[];
}

export function planCollection({ models, referenced, rowsPerSha, rowsPerOriginal, now }: CollectInput): CollectionPlan {
  const cutoff = now.getTime() - COLLECT_AFTER_DAYS * 86_400_000;
  const going = models.filter((m) => !referenced.has(`${m.siteId}/${m.sha256}`) && Math.max(m.createdAt.getTime(), m.lastUsedAt.getTime()) < cutoff);
  const count = (map: ReadonlyMap<string, number>, key: string) => map.get(key) ?? Number.POSITIVE_INFINITY;
  const dropped = (key: (m: (typeof going)[number]) => string) => {
    const per = new Map<string, number>();
    for (const m of going) per.set(key(m), (per.get(key(m)) ?? 0) + 1);
    return per;
  };
  const served = dropped((m) => m.sha256);
  const originals = dropped((m) => m.originalSha256);
  return {
    rows: going.map(({ siteId, sha256 }) => ({ siteId, sha256 })),
    // An unknown count is treated as "still held": nothing is deleted on a guess.
    blobs: [...served].filter(([sha, n]) => count(rowsPerSha, sha) - n <= 0).map(([sha]) => sha),
    originals: [...originals].filter(([sha, n]) => count(rowsPerOriginal, sha) - n <= 0).map(([sha]) => sha),
  };
}
