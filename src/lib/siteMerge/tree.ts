// src/lib/siteMerge/tree.ts
//
// The three-way merge of a tree of nodes: one page's app tree and canvas nodes, or one reusable component's
// page (docs/plans/2026-11-10-site-branches.md, section 5, rules 1 to 8). Nodes are compared by id, never
// by position. Each tree is first made flat (node to parent, plus each parent's ordered children); the
// flat forms are merged; the result is built into a tree again.
//
// - Fields of a node merge per field; `props`, its `style`, a responsive value and `bindings` per key.
// - A node added on one side is kept; the same id added on both sides with different content conflicts.
// - A node removed on one side and untouched on the other goes. Removed on one side and changed on the
//   other (the node, a node inside it, a child added or moved into it, or left pointed at by the merge) is one conflict for the whole removed
//   part, asked on its top node: keep it with the changes, or remove it.
// - A move on one side is taken; different moves on both sides conflict, and so do two moves that would put
//   a node inside itself.
// - Children follow main's order; what the branch added goes after the sibling it followed there. Both
//   sides reordering the same parent's children conflicts on that parent.
//
// PURE: client and server safe.

import { mergeOrder } from './order';
import { conflictId, type ConflictLog, type MergeSide, type MergeUnit } from './types';
import { isPlainObject, jsonEqual, mergeValue, type SplitRule } from './value';

/** A node as stored: an `id`, its own fields, and its `children`. */
export type TreeNode = Record<string, unknown> & { id: string; children?: unknown[] };

/**
 * A container's roots, by slot: `app` holds a page's app tree (one root), `canvas` its canvas nodes
 * (stored as a map, so their order carries no meaning).
 */
export interface Forest {
  slots: Record<string, TreeNode[]>;
}

/** Slots whose roots have no order. */
const UNORDERED_SLOTS = new Set(['canvas']);

export interface Flat {
  /** Each node's own fields, without `children`. */
  fields: Map<string, Record<string, unknown>>;
  /** Each node's parent: a node id, or `#<slot>` for a root. */
  parent: Map<string, string>;
  /** Each parent's children in order (a node id or `#<slot>` as the key). */
  children: Map<string, string[]>;
}

const slotKey = (slot: string) => `#${slot}`;
const isSlotKey = (key: string) => key.startsWith('#');

export function flatten(forest: Forest | undefined): Flat {
  const flat: Flat = { fields: new Map(), parent: new Map(), children: new Map() };
  const visit = (node: unknown, parent: string) => {
    if (!isPlainObject(node) || typeof node.id !== 'string') return;
    const id = node.id;
    // An id seen twice in one container is a broken document: the first one counts.
    if (flat.fields.has(id)) return;
    const { children, ...fields } = node as TreeNode;
    flat.fields.set(id, fields);
    flat.parent.set(id, parent);
    pushChild(flat, parent, id);
    // A stored `children: []` is kept as it is: the key's presence is recorded even with nothing in it.
    if (Array.isArray(children)) {
      if (!flat.children.has(id)) flat.children.set(id, []);
      for (const child of children) visit(child, id);
    }
  };
  for (const [slot, roots] of Object.entries(forest?.slots ?? {})) {
    flat.children.set(slotKey(slot), flat.children.get(slotKey(slot)) ?? []);
    for (const root of roots) visit(root, slotKey(slot));
  }
  return flat;
}

function pushChild(flat: Flat, parent: string, id: string) {
  const list = flat.children.get(parent);
  if (list) list.push(id);
  else flat.children.set(parent, [id]);
}

/**
 * Which parts of a node merge per key: its fields, `props`, `props.style`, `bindings`, and a responsive
 * value (an object with a `base` key) in `props` or the style.
 */
export const NODE_SPLIT: SplitRule = (path, sides) => {
  if (path.length === 0) return true;
  if (path.length === 1) return path[0] === 'props' || path[0] === 'bindings';
  if (path[0] !== 'props') return false;
  if (path.length === 2 && path[1] === 'style') return true;
  const responsive = sides.some((side) => isPlainObject(side) && 'base' in side);
  return responsive && (path.length === 2 || (path.length === 3 && path[1] === 'style'));
};

/** Merge one container's forest three ways, reporting conflicts to `log` (keyed under `container`). */
export function mergeForest(
  base: Forest | undefined,
  main: Forest | undefined,
  branch: Forest | undefined,
  container: string,
  log: ConflictLog,
  /** Node ids a previous pass left something pointing at (rule 10): a removal of one of them is asked. */
  referenced: ReadonlySet<string> = new Set(),
): { forest: Forest } {
  const B = flatten(base);
  const M = flatten(main);
  const R = flatten(branch);
  const unit = (id: string): MergeUnit => ({ kind: 'node', id, container });

  /** The merged node: its fields and parent, or absent. */
  const fields = new Map<string, Record<string, unknown>>();
  const parent = new Map<string, string>();
  /** Where a node's parent came from, for the fallback when that parent is gone. */
  const parentFrom = new Map<string, MergeSide | 'base'>();
  /** Nodes decided by a removal (kept with the keeper's structure, or removed): not merged again below. */
  const decided = new Set<string>();

  // Removed on one side: grouped under the top node of each removed part, kept or removed as one.
  const decideRemovals = (remover: MergeSide) => {
    const keeper: MergeSide = remover === 'main' ? 'branch' : 'main';
    const K = keeper === 'main' ? M : R;
    const X = remover === 'main' ? M : R;
    const removed = new Set([...B.fields.keys()].filter((id) => K.fields.has(id) && !X.fields.has(id)));
    if (removed.size === 0) return;
    const groupOf = new Map<string, string>();
    // The top removed node above each removed node (iterative: a deep tree must not exhaust the stack).
    const top = (start: string): string => {
      const chain: string[] = [];
      let id = start;
      let root: string | undefined;
      while (root === undefined) {
        const known = groupOf.get(id);
        if (known) root = known;
        else {
          chain.push(id);
          const up = K.parent.get(id)!;
          if (removed.has(up)) id = up;
          else root = id;
        }
      }
      for (const visited of chain) groupOf.set(visited, root);
      return root;
    };
    const push = (map: Map<string, string[]>, key: string, id: string) => {
      const list = map.get(key);
      if (list) list.push(id);
      else map.set(key, [id]);
    };
    const groups = new Map<string, string[]>();
    for (const id of removed) push(groups, top(id), id);
    // Nodes the keeper added inside a removed part belong to that part.
    const added = new Map<string, string[]>();
    for (const id of K.fields.keys()) {
      if (B.fields.has(id)) continue;
      let up = K.parent.get(id)!;
      while (!isSlotKey(up) && !B.fields.has(up) && K.parent.has(up)) up = K.parent.get(up)!;
      if (removed.has(up)) push(added, top(up), id);
    }
    for (const [root, members] of groups) {
      const extra = added.get(root) ?? [];
      const changed =
        extra.length > 0 ||
        members.some((id) => referenced.has(id)) ||
        members.some(
          (id) =>
            !jsonEqual(B.fields.get(id), K.fields.get(id)) ||
            B.parent.get(id) !== K.parent.get(id) ||
            !jsonEqual(B.children.get(id) ?? [], K.children.get(id) ?? []),
        );
      let keep = false;
      if (changed) {
        const project = (flat: Flat) =>
          [...members, ...extra].sort().map((id) => (flat.fields.has(id) ? { ...flat.fields.get(id), parent: flat.parent.get(id) } : null));
        const pick = log.ask({
          id: conflictId(unit(root), 'removed'),
          kind: 'removed',
          unit: unit(root),
          path: [],
          base: project(B),
          main: project(M),
          branch: project(R),
          removedOn: remover,
        });
        // No answer: main's side stands in.
        keep = (pick ?? 'main') === keeper;
      }
      for (const id of [...members, ...extra]) {
        if (keep) {
          fields.set(id, K.fields.get(id)!);
          parent.set(id, K.parent.get(id)!);
          parentFrom.set(id, keeper);
        }
        decided.add(id);
      }
    }
  };
  decideRemovals('main');
  decideRemovals('branch');

  const ids = new Set([...B.fields.keys(), ...M.fields.keys(), ...R.fields.keys()]);
  for (const id of ids) {
    if (decided.has(id)) continue;
    const inB = B.fields.has(id);
    const inM = M.fields.has(id);
    const inR = R.fields.has(id);
    if (inB && !inM && !inR) continue; // removed on both sides
    if (!inB) {
      // Added: on one side, kept; on both, once when equal, else a conflict (rule 4).
      let side: MergeSide = inM ? 'main' : 'branch';
      if (inM && inR) {
        const same = jsonEqual(M.fields.get(id), R.fields.get(id)) && M.parent.get(id) === R.parent.get(id);
        if (!same) {
          side =
            log.ask({
              id: conflictId(unit(id), 'added-twice'),
              kind: 'added-twice',
              unit: unit(id),
              path: [],
              base: undefined,
              main: { ...M.fields.get(id), parent: M.parent.get(id) },
              branch: { ...R.fields.get(id), parent: R.parent.get(id) },
            }) ?? 'main';
        }
      }
      const S = side === 'main' ? M : R;
      fields.set(id, S.fields.get(id)!);
      parent.set(id, S.parent.get(id)!);
      parentFrom.set(id, side);
      continue;
    }
    // On all three sides (a removal was decided above).
    const merged = mergeValue(B.fields.get(id), M.fields.get(id), R.fields.get(id), {
      split: NODE_SPLIT,
      pick: (path, c) =>
        log.ask({ id: conflictId(unit(id), 'value', path), kind: 'value', unit: unit(id), path: [...path], base: c.base, main: c.main, branch: c.branch }),
    });
    fields.set(id, merged.value as Record<string, unknown>);
    const b = B.parent.get(id)!;
    const m = M.parent.get(id)!;
    const r = R.parent.get(id)!;
    if (m === r || b === r) {
      parent.set(id, m);
      parentFrom.set(id, m === b ? 'base' : 'main');
    } else if (b === m) {
      parent.set(id, r);
      parentFrom.set(id, 'branch');
    } else {
      const pick = log.ask({ id: conflictId(unit(id), 'moved'), kind: 'moved', unit: unit(id), path: [], base: b, main: m, branch: r }) ?? 'main';
      parent.set(id, pick === 'main' ? m : r);
      parentFrom.set(id, pick);
    }
  }

  // Two moves that would put a node inside itself: asked once per loop, on its smallest id.
  for (const loop of findLoops(parent)) {
    const first = [...loop].sort()[0];
    const pick =
      log.ask({
        id: conflictId(unit(first), 'cycle'),
        kind: 'cycle',
        unit: unit(first),
        path: [],
        base: loop.map((id) => B.parent.get(id)),
        main: loop.map((id) => M.parent.get(id)),
        branch: loop.map((id) => R.parent.get(id)),
      }) ?? 'main';
    const S = pick === 'main' ? M : R;
    for (const id of loop) {
      const up = S.parent.get(id) ?? B.parent.get(id);
      if (up !== undefined) {
        parent.set(id, up);
        parentFrom.set(id, pick);
      }
    }
  }
  // Still a loop (a mix the answer could not undo): main's places for every node in it.
  for (const loop of findLoops(parent)) for (const id of loop) if (M.parent.has(id)) parent.set(id, M.parent.get(id)!);

  // A node whose merged parent is gone (its part was removed by an answer): the other side's place, then
  // the base's; with none left it goes too.
  for (let changed = true; changed; ) {
    changed = false;
    const orphans = [...parent].filter(([, up]) => !isSlotKey(up) && !fields.has(up));
    for (const [id] of orphans) {
      const from = parentFrom.get(id);
      const candidates = [from === 'main' ? R.parent.get(id) : M.parent.get(id), B.parent.get(id)];
      const next = candidates.find((c) => c !== undefined && (isSlotKey(c) || fields.has(c)));
      if (next) parent.set(id, next);
      else {
        parent.delete(id);
        fields.delete(id);
      }
      changed = true;
    }
  }

  // Children in order, per parent.
  const childrenOf = new Map<string, string[]>();
  for (const [id, up] of parent) {
    const list = childrenOf.get(up);
    if (list) list.push(id);
    else childrenOf.set(up, [id]);
  }
  const order = (key: string): string[] => {
    const present = new Set(childrenOf.get(key) ?? []);
    const parentUnit: MergeUnit = isSlotKey(key) ? { kind: 'node', id: key, container } : unit(key);
    return mergeOrder(B.children.get(key) ?? [], M.children.get(key) ?? [], R.children.get(key) ?? [], present, {
      unordered: isSlotKey(key) && UNORDERED_SLOTS.has(key.slice(1)),
      ask: (base, main, branch) => log.ask({ id: conflictId(parentUnit, 'order'), kind: 'order', unit: parentUnit, path: [], base, main, branch }),
    });
  };

  const build = (id: string): TreeNode => {
    const node: TreeNode = { ...(fields.get(id) as Record<string, unknown>), id } as TreeNode;
    const kids = order(id);
    // A node keeps `children` exactly when one of the sides stored it (a leaf stored without the key stays so).
    if (kids.length > 0 || [M, R, B].some((flat) => flat.children.has(id))) node.children = kids.map(build);
    return node;
  };
  const slots: Record<string, TreeNode[]> = {};
  const slotNames = new Set([...Object.keys(main?.slots ?? {}), ...Object.keys(branch?.slots ?? {}), ...Object.keys(base?.slots ?? {})]);
  for (const slot of slotNames) slots[slot] = order(slotKey(slot)).map(build);
  return { forest: { slots } };
}

/** Every loop in a parent map (nodes whose parent chain comes back to them), each listed once. */
function findLoops(parent: ReadonlyMap<string, string>): string[][] {
  const state = new Map<string, 'visiting' | 'done'>();
  const loops: string[][] = [];
  for (const start of parent.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let id: string | undefined = start;
    while (id !== undefined && !isSlotKey(id) && !state.has(id) && parent.has(id)) {
      state.set(id, 'visiting');
      path.push(id);
      id = parent.get(id);
    }
    if (id !== undefined && state.get(id) === 'visiting') loops.push(path.slice(path.indexOf(id)));
    for (const p of path) state.set(p, 'done');
  }
  return loops;
}
