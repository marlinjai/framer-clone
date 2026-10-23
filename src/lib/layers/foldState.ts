// src/lib/layers/foldState.ts
//
// Which container rows of the Layers tree are folded. The state is a set of
// COLLAPSED component ids: the zero state (empty set) shows every row
// expanded, and a node that is deleted or never seen simply is not in it.
//
// Fold state is editor UI, never part of the saved project and never in undo
// history. It lives for the editor session (EditorUIStore) and is not
// remembered across reloads: ids from a stale project would only pile up.
//
// The functions are pure (take a set, return a new set) so the rules are unit
// tested without React or MobX.

/** Minimal tree shape the helpers walk. */
export interface FoldNode {
  id: string;
  children: readonly FoldNode[];
}

/** Every id in the subtree that has children (the rows that can fold), the root included. */
export function containerIds(root: FoldNode): string[] {
  const out: string[] = [];
  const stack: FoldNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.children.length > 0) {
      out.push(node.id);
      stack.push(...node.children);
    }
  }
  return out;
}

/** Fold or unfold one row. */
export function toggleFold(collapsed: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Alt+click on a chevron: the row and every container below it take the
 * row's NEW state. A collapsed row opens together with all its descendants;
 * an open row folds together with all of them.
 */
export function toggleFoldSubtree(collapsed: ReadonlySet<string>, node: FoldNode): Set<string> {
  const ids = containerIds(node);
  const next = new Set(collapsed);
  const collapse = !collapsed.has(node.id);
  for (const id of ids) {
    if (collapse) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Collapse all: every container in the given trees folds. */
export function collapseAll(collapsed: ReadonlySet<string>, roots: readonly FoldNode[]): Set<string> {
  const next = new Set(collapsed);
  for (const root of roots) for (const id of containerIds(root)) next.add(id);
  return next;
}

/** Expand all: every container in the given trees opens. */
export function expandAll(collapsed: ReadonlySet<string>, roots: readonly FoldNode[]): Set<string> {
  const next = new Set(collapsed);
  for (const root of roots) for (const id of containerIds(root)) next.delete(id);
  return next;
}

/**
 * Open every ancestor of a node so its row is visible (a canvas selection
 * reveals its layer). Returns the same set when nothing changes, so callers
 * can skip a store write.
 */
export function expandAncestors(collapsed: ReadonlySet<string>, ancestorIds: readonly string[]): ReadonlySet<string> {
  if (!ancestorIds.some(id => collapsed.has(id))) return collapsed;
  const next = new Set(collapsed);
  for (const id of ancestorIds) next.delete(id);
  return next;
}
