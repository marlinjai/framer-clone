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
 * when its ref was created on the plan's page AS A SECTION: a root node of an
 * insertNodes op into the page root (no parentId, or the root's own id, which
 * `rootOf` answers), or a placeComponent into the page root. A ref inside a tree, or one
 * inserted into an existing section, is not a section and is left out. A
 * node's page is its op's `pageId`, resolved through `created` when it is
 * `ref:<page>` (a page the same batch made). A createPage op's own ref names a
 * page, never a node, and is left out. Pure.
 */
export function refPagesOf(ops: unknown, created: unknown, rootOf: (pageId: string) => string | undefined = () => undefined): Record<string, string> {
  const ids = (typeof created === 'object' && created !== null && !Array.isArray(created) ? created : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  if (!Array.isArray(ops)) return out;
  const pageOf = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    if (!value.startsWith('ref:')) return value;
    const id = ids[value.slice(4)];
    return typeof id === 'string' ? id : undefined;
  };
  const take = (ref: unknown, pageId: string) => {
    if (typeof ref === 'string' && typeof ids[ref] === 'string') out[ref] = pageId;
  };
  for (const raw of ops) {
    const op = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const pageId = pageOf(op.pageId);
    if (!pageId) continue;
    const intoRoot = (parentId: unknown) => parentId === undefined || (typeof parentId === 'string' && parentId === rootOf(pageId));
    if (op.op === 'insertNodes' && intoRoot(op.parentId) && Array.isArray(op.nodes)) {
      for (const node of op.nodes) take((typeof node === 'object' && node !== null ? (node as Record<string, unknown>) : {}).ref, pageId);
    }
    if (op.op === 'placeComponent') {
      const to = typeof op.to === 'object' && op.to !== null ? (op.to as Record<string, unknown>) : {};
      if (intoRoot(to.parentId)) take(op.ref, pageId);
    }
  }
  return out;
}
