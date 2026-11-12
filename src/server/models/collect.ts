// src/server/models/collect.ts
//
// Which stored models may be collected (plan, "Storage"): a published revision freezes the hashes
// it references, so a model a revision uses is never deleted while that revision is kept; a model
// no kept revision and no draft references is collected after 30 days. Pure planner: it decides,
// it deletes nothing.

export const COLLECT_AFTER_DAYS = 30;

export interface CollectInput {
  models: { siteId: string; sha256: string; createdAt: Date }[];
  /** `siteId/sha256` of every model any kept revision or any draft of the site references. */
  referenced: ReadonlySet<string>;
  now: Date;
}

export interface CollectionPlan {
  /** Rows to delete. */
  rows: { siteId: string; sha256: string }[];
  /** Hashes whose blob may go too: no row of any site keeps them (blobs are content-addressed and shared across sites). */
  blobs: string[];
}

export function planCollection({ models, referenced, now }: CollectInput): CollectionPlan {
  const cutoff = now.getTime() - COLLECT_AFTER_DAYS * 86_400_000;
  const rows = models
    .filter((m) => !referenced.has(`${m.siteId}/${m.sha256}`) && m.createdAt.getTime() <= cutoff)
    .map(({ siteId, sha256 }) => ({ siteId, sha256 }));
  const going = new Set(rows.map((r) => `${r.siteId}/${r.sha256}`));
  const kept = new Set(models.filter((m) => !going.has(`${m.siteId}/${m.sha256}`)).map((m) => m.sha256));
  return { rows, blobs: [...new Set(rows.map((r) => r.sha256))].filter((sha) => !kept.has(sha)) };
}
