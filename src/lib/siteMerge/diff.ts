// src/lib/siteMerge/diff.ts
//
// What changed from one site document to another, as counts and ids (docs/plans/2026-11-10-site-branches.md,
// slices S3 and S5): the branch list's "3 pages changed", and the review's list of what a merge brings into
// main. A page's timestamps are not a change (decision 33), and a node counts as changed when its own fields,
// its parent or the relative order of the children it keeps differ.
//
// PURE: client and server safe.

import { jsonEqual, isPlainObject } from './value';
import { flatten } from './tree';
import { forestOf, SITE_FIELDS, withoutTimestamps, type MergeDocument } from './document';

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
    if (!jsonEqual(stripped(before), stripped(after))) out.changed.push(id);
    const n = nodeChanges(bodyOf(before), bodyOf(after));
    nodes.added += n.added;
    nodes.removed += n.removed;
    nodes.changed += n.changed;
  }
  out.added.sort();
  out.removed.sort();
  out.changed.sort();
}

const stripped = (unit: unknown) => (isPlainObject(unit) ? withoutTimestamps(unit) : unit);

function nodeChanges(before: unknown, after: unknown) {
  const a = flatten(forestOf(isPlainObject(before) ? before : {}));
  const b = flatten(forestOf(isPlainObject(after) ? after : {}));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const id of b.fields.keys()) if (!a.fields.has(id)) added++;
  for (const [id, fields] of a.fields) {
    const otherFields = b.fields.get(id);
    if (!otherFields) {
      removed++;
      continue;
    }
    const kids = a.children.get(id) ?? [];
    const otherKids = b.children.get(id) ?? [];
    // A parent's order compares only the children it holds on both sides (rule 8): a move counts on the moved
    // node, not again on the two parents.
    const theirs = new Set(otherKids);
    const kept = new Set(kids.filter((child) => theirs.has(child)));
    const order = (list: string[]) => list.filter((child) => kept.has(child));
    if (a.parent.get(id) !== b.parent.get(id) || !jsonEqual(fields, otherFields) || !jsonEqual(order(kids), order(otherKids))) changed++;
  }
  return { added, removed, changed };
}

/**
 * How many things a set of changes holds: THE one definition of "this branch changes nothing" (zero). The agent's
 * status, the review's merge button and the merge itself all ask this, so they cannot disagree. It counts what a
 * merge would write, a frame moved on the editor's canvas included, which the review's change list leaves out.
 */
export function countChanges(changes: DocumentChanges): number {
  return (
    changes.site.length +
    changes.settings.length +
    changes.pages.added.length +
    changes.pages.removed.length +
    changes.pages.changed.length +
    changes.components.added.length +
    changes.components.removed.length +
    changes.components.changed.length +
    changes.nodes.added +
    changes.nodes.removed +
    changes.nodes.changed +
    (changes.pageOrder ? 1 : 0)
  );
}
