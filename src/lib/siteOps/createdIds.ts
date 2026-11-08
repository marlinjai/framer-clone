// src/lib/siteOps/createdIds.ts
//
// What a batch created, split into pages and nodes. A batch's `created` map goes
// from each op's `ref` to the id the server gave it; a `createPage` op's ref names a
// PAGE, every other ref a node. The live agent canvas frames a node's section but
// opens a page, and its feed (live and after a reload, from the audit row) must
// tell them apart. Ids only: both the live reports and the audit rows read this.

export interface CreatedIds {
  /** The ids of the nodes the batch created (and inserted). */
  nodeIds: string[];
  /** The ids of the pages the batch created, in the order of their refs. */
  pageIds: string[];
}

/** Splits a batch's `created` map by the `createPage` refs among its ops. Anything not a string is ignored. */
export function splitCreated(ops: unknown, created: unknown): CreatedIds {
  const pageRefs = new Set<string>();
  if (Array.isArray(ops)) {
    for (const raw of ops) {
      const op = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      if (op.op === 'createPage' && typeof op.ref === 'string') pageRefs.add(op.ref);
    }
  }
  const out: CreatedIds = { nodeIds: [], pageIds: [] };
  if (typeof created !== 'object' || created === null || Array.isArray(created)) return out;
  for (const [ref, id] of Object.entries(created as Record<string, unknown>)) {
    if (typeof id !== 'string') continue;
    (pageRefs.has(ref) ? out.pageIds : out.nodeIds).push(id);
  }
  return out;
}
