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

/**
 * The page each ref of a batch landed on (ref to page id), for the skeleton
 * plans of the live agent canvas: an announced section counts as written only
 * when its ref was created on the plan's page. A node's page is its
 * insertNodes or placeComponent op's `pageId`, resolved through `created` when
 * it is `ref:<page>` (a page the same batch made). A createPage op's own ref
 * names a page, never a node, and is left out. Refs nested inside an inserted
 * tree land on the same page. Pure.
 */
export function refPagesOf(ops: unknown, created: unknown): Record<string, string> {
  const ids = (typeof created === 'object' && created !== null && !Array.isArray(created) ? created : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  if (!Array.isArray(ops)) return out;
  const pageOf = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    if (!value.startsWith('ref:')) return value;
    const id = ids[value.slice(4)];
    return typeof id === 'string' ? id : undefined;
  };
  const walk = (node: unknown, pageId: string, depth: number) => {
    if (depth > 64 || typeof node !== 'object' || node === null) return;
    const n = node as Record<string, unknown>;
    if (typeof n.ref === 'string' && typeof ids[n.ref] === 'string') out[n.ref] = pageId;
    if (Array.isArray(n.children)) for (const child of n.children) walk(child, pageId, depth + 1);
  };
  for (const raw of ops) {
    const op = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const pageId = pageOf(op.pageId);
    if (!pageId) continue;
    if (op.op === 'insertNodes' && Array.isArray(op.nodes)) for (const node of op.nodes) walk(node, pageId, 0);
    if (op.op === 'placeComponent' && typeof op.ref === 'string' && typeof ids[op.ref] === 'string') out[op.ref] = pageId;
  }
  return out;
}
