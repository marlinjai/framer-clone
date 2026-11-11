// src/lib/siteMerge/diff.ts
//
// What changed from one site document to another, as counts and ids (docs/plans/2026-11-10-site-branches.md,
// slices S3 and S5): the branch list's "3 pages changed", and the review's list of what a merge brings into
// main. A page's timestamps are not a change (decision 33), and a node counts as changed when its own fields,
// its parent or the relative order of the children it keeps differ.
//
// PURE: client and server safe.

import { jsonEqual, isPlainObject } from './value';
import { treesOf } from './references';
import type { MergeDocument } from './document';

export interface UnitChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface DocumentChanges {
  /** The site's own fields that differ. */
  site: string[];
  /** The settings' top-level keys that differ. */
  settings: string[];
  pages: UnitChanges;
  components: UnitChanges;
  /** Nodes added, removed or changed, over every page and component both documents hold. */
  nodes: { added: number; removed: number; changed: number };
  /** Whether the order of the pages differs (left out pages only one side has). */
  pageOrder: boolean;
}

const SITE_FIELDS = ['name', 'description', 'analyticsProjectId', 'ingestionEndpoint', 'apiKeyRef', 'lumitraEnabled'] as const;
const TIMESTAMPS = ['createdAt', 'updatedAt'];

export function diffDocuments(from: MergeDocument, to: MergeDocument): DocumentChanges {
  const changes: DocumentChanges = {
    site: SITE_FIELDS.filter((field) => !jsonEqual(from[field], to[field])),
    settings: [],
    pages: { added: [], removed: [], changed: [] },
    components: { added: [], removed: [], changed: [] },
    nodes: { added: 0, removed: 0, changed: 0 },
    pageOrder: false,
  };

  const a = isPlainObject(from.siteSettings) ? from.siteSettings : {};
  const b = isPlainObject(to.siteSettings) ? to.siteSettings : {};
  changes.settings = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !jsonEqual(a[key], b[key])).sort();

  const fromPages = new Map(from.pages.map((p) => [p.pageId, p.snapshot]));
  const toPages = new Map(to.pages.map((p) => [p.pageId, p.snapshot]));
  units(fromPages, toPages, changes.pages, changes.nodes, (page) => page);
  const shared = (pages: MergeDocument['pages'], other: Map<string, unknown>) => pages.map((p) => p.pageId).filter((id) => other.has(id));
  changes.pageOrder = !jsonEqual(shared(from.pages, toPages), shared(to.pages, fromPages));

  const fromComponents = new Map(Object.entries(from.components ?? {}));
  const toComponents = new Map(Object.entries(to.components ?? {}));
  units(fromComponents, toComponents, changes.components, changes.nodes, (definition) => (isPlainObject(definition) ? definition.page : undefined));
  return changes;
}

function units(
  from: Map<string, unknown>,
  to: Map<string, unknown>,
  out: UnitChanges,
  nodes: DocumentChanges['nodes'],
  bodyOf: (unit: unknown) => unknown,
) {
  for (const id of to.keys()) if (!from.has(id)) out.added.push(id);
  for (const id of from.keys()) if (!to.has(id)) out.removed.push(id);
  for (const [id, before] of from) {
    const after = to.get(id);
    if (after === undefined) continue;
    if (!jsonEqual(withoutTimestamps(before), withoutTimestamps(after))) out.changed.push(id);
    const n = nodeChanges(treesOf(bodyOf(before)), treesOf(bodyOf(after)));
    nodes.added += n.added;
    nodes.removed += n.removed;
    nodes.changed += n.changed;
  }
  out.added.sort();
  out.removed.sort();
  out.changed.sort();
}

function withoutTimestamps(unit: unknown): unknown {
  if (!isPlainObject(unit)) return unit;
  const copy: Record<string, unknown> = { ...unit };
  for (const key of TIMESTAMPS) delete copy[key];
  if (isPlainObject(copy.page)) copy.page = withoutTimestamps(copy.page);
  return copy;
}

interface FlatNode {
  fields: Record<string, unknown>;
  parent: string;
  children: string[];
}

function flat(trees: readonly unknown[]): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();
  const stack: Array<[unknown, string]> = trees.map((tree) => [tree, '#root']).reverse() as Array<[unknown, string]>;
  let guard = 0;
  while (stack.length > 0 && guard++ < 1_000_000) {
    const [node, parent] = stack.pop()!;
    if (!isPlainObject(node) || typeof node.id !== 'string' || out.has(node.id)) continue;
    const { children, ...fields } = node;
    const kids = Array.isArray(children) ? children.filter((c) => isPlainObject(c) && typeof c.id === 'string') : [];
    out.set(node.id, { fields, parent, children: kids.map((c) => (c as { id: string }).id) });
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], node.id]);
  }
  return out;
}

function nodeChanges(before: readonly unknown[], after: readonly unknown[]) {
  const a = flat(before);
  const b = flat(after);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const id of b.keys()) if (!a.has(id)) added++;
  for (const [id, node] of a) {
    const other = b.get(id);
    if (!other) {
      removed++;
      continue;
    }
    // A parent's order compares only the children it holds on both sides (rule 8): a move counts on the moved
    // node, not again on the two parents.
    const theirs = new Set(other.children);
    const kept = new Set(node.children.filter((child) => theirs.has(child)));
    const order = (n: FlatNode) => n.children.filter((child) => kept.has(child));
    if (node.parent !== other.parent || !jsonEqual(node.fields, other.fields) || !jsonEqual(order(node), order(other))) changed++;
  }
  return { added, removed, changed };
}
