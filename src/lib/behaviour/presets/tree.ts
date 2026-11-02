// src/lib/behaviour/presets/tree.ts
//
// A tree view and a tree grid. See docs/plans/2026-11-02-behaviour-model.md, "Presets" and
// "Decided in slice B4" (the tree axis).
//
// Tree view: Down and Up through what is visible, Home and End, a printable key to the next
// item starting with it; Right opens a closed branch and enters an open one; Left closes an
// open branch and otherwise goes to the parent; Enter opens or closes a branch. Each branch
// holds its own open state, so `aria-expanded` and its group follow it.
//
// Every ancestor holding a trigger hears a key, from the focused item up. So the item that
// acts marks the key handled, every item above it reads that and does nothing, and the root
// clears it last. That is how Left on a leaf moves to its parent without also closing the
// branch around it.
//
// Tree grid: the same on rows. Child rows are siblings of their parent in a table, so a
// row's open state sits on the table and a child row shows while every row above it is
// open.
//
// Without a script every branch is open, and every row shows.
//
// PURE: no React, no MST.

import type { Action, Condition, Trigger } from '../format';
import { assertSeed, derived, el, onKeys, propsOf, stateIdOn, type PresetNode } from './nodes';

export const TREE_VERSION = 1;

export interface TreeEntry {
  title: string;
  children?: TreeEntry[];
}

export interface TreeOptions {
  seed: string;
  label?: string;
  items?: TreeEntry[];
}

const DEFAULT_ITEMS: readonly TreeEntry[] = [
  { title: 'Fruit', children: [{ title: 'Apple' }, { title: 'Pear', children: [{ title: 'Williams' }, { title: 'Conference' }] }] },
  { title: 'Vegetables', children: [{ title: 'Carrot' }, { title: 'Leek' }] },
  { title: 'Bread' },
];

/** The keys an item acts on itself. */
const OWN_KEYS = ['InlineEnd', 'InlineStart', 'Enter'];

const isItem = (node: PresetNode): boolean => propsOf(node).role === 'treeitem';
const isGroup = (node: PresetNode): boolean => propsOf(node).role === 'group';

const not = (state: string): Condition => ({ state, eq: false });
const both = (...all: Condition[]): Condition => ({ all });

/** Writes every generated entry from the items the tree holds, at any depth. */
export function deriveTree(root: PresetNode): PresetNode {
  const handled = stateIdOn(root, 'handled');
  const go = (move: 'next' | 'prev' | 'first' | 'last' | 'up' | 'down' | 'type') => ({ rove: root.id, move });
  const done: Action = { set: handled, value: true };

  const item = (node: PresetNode): PresetNode => {
    const group = node.children?.find(isGroup);
    if (!group) {
      return derived(node, { on: [{ ...onKeys('parent', ['InlineStart'], go('up'), done), if: not(handled) }] });
    }
    const open = stateIdOn(node, 'open');
    const shownGroup = derived({ ...group, children: group.children?.map(item) }, { showWhen: { state: open, eq: true } });
    const when = (...also: Condition[]): Condition => both(not(handled), ...also);
    const on: Trigger[] = [
      { ...onKeys('enter', ['InlineEnd'], go('down'), done), if: when({ state: open, eq: true }) },
      { ...onKeys('open', ['InlineEnd'], { set: open, value: true }, done), if: when(not(open)) },
      { ...onKeys('close', ['InlineStart'], { set: open, value: false }, done), if: when({ state: open, eq: true }) },
      { ...onKeys('parent', ['InlineStart'], go('up'), done), if: when(not(open)) },
      { ...onKeys('flip', ['Enter'], { toggle: open }, done), if: when() },
    ];
    return derived({ ...node, children: node.children?.map((child) => (child === group ? shownGroup : child)) }, {
      state: [{ id: open, name: 'Branch open', type: 'boolean', initial: false }],
      bind: [{ attr: 'aria-expanded', from: { get: open } }],
      on,
    });
  };

  return derived({ ...root, children: root.children?.map((child) => (isItem(child) ? item(child) : child)) }, {
    state: [{ id: handled, name: 'Key handled', type: 'boolean', initial: false }],
    group: { role: 'treeitem', axis: 'tree' },
    on: [
      onKeys('next', ['ArrowDown'], go('next')),
      onKeys('prev', ['ArrowUp'], go('prev')),
      onKeys('first', ['Home'], go('first')),
      onKeys('last', ['End'], go('last')),
      { id: 'type', on: 'keydown', keys: ['Printable'], do: [go('type')] },
      // Last of all, from the root: the next key starts unhandled.
      { id: 'clear', on: 'keydown', keys: OWN_KEYS, do: [{ set: handled, value: false }] },
    ],
    preset: { kind: 'treeview', version: TREE_VERSION },
  });
}

const ITEM_STYLE = { padding: '6px 8px', cursor: 'default', listStyle: 'none' };

function treeItem(seed: string, entry: TreeEntry, path: string): PresetNode {
  const id = `${seed}-${path}`;
  if (!entry.children?.length) return el(id, 'li', { role: 'treeitem', children: entry.title, style: ITEM_STYLE });
  return el(id, 'li', { role: 'treeitem', style: ITEM_STYLE },
    el(`${id}-name`, 'span', { children: entry.title }),
    el(`${id}-group`, 'ul', { role: 'group', style: { margin: '4px 0 0', padding: '0 0 0 16px' } },
      ...entry.children.map((child, at) => treeItem(seed, child, `${path}-${at}`))));
}

export function treeview({ seed, label = 'Files', items = [...DEFAULT_ITEMS] }: TreeOptions): PresetNode {
  assertSeed(seed);
  return deriveTree(
    el(seed, 'ul', { role: 'tree', 'aria-label': label, style: { margin: '0', padding: '0' } },
      ...items.map((entry, at) => treeItem(seed, entry, String(at)))),
  );
}

// ---- tree grid -------------------------------------------------------------------------

export interface TreegridOptions {
  seed: string;
  label?: string;
  columns?: string[];
  rows?: TreegridEntry[];
}

export interface TreegridEntry {
  cells: string[];
  children?: TreegridEntry[];
}

const DEFAULT_COLUMNS = ['Subject', 'From'];
const DEFAULT_ROWS: readonly TreegridEntry[] = [
  { cells: ['Lunch', 'Ana'], children: [{ cells: ['Re: Lunch', 'Ben'] }, { cells: ['Re: Lunch', 'Cleo'] }] },
  { cells: ['Report', 'Dan'] },
];

const isRow = (node: PresetNode): boolean => propsOf(node).role === 'row' && propsOf(node)['aria-level'] !== undefined;
const levelOf = (node: PresetNode): number => Number(propsOf(node)['aria-level']) || 1;

/**
 * Writes every generated entry from the rows the body holds, read by their `aria-level`.
 * A row is a branch when the next row is deeper. Rows are siblings, so no key reaches two of
 * them, and a row reaches its parent by name.
 */
export function deriveTreegrid(root: PresetNode): PresetNode {
  const body = root.children?.find((child) => child.type === 'tbody');
  if (!body) return root;
  const rows = (body.children ?? []).filter(isRow);
  const go = (move: 'next' | 'prev' | 'first' | 'last' | 'type') => ({ rove: body.id, move });
  const openOf = (row: PresetNode): string => `${row.id}-open`;
  const parents: (PresetNode | undefined)[] = rows.map((row, at) => rows.slice(0, at).reverse().find((above) => levelOf(above) < levelOf(row)));
  const ancestors = (at: number): PresetNode[] => {
    const out: PresetNode[] = [];
    for (let parent = parents[at]; parent; parent = parents[rows.indexOf(parent)]) out.push(parent);
    return out;
  };
  const branches = rows.filter((row, at) => rows[at + 1] !== undefined && levelOf(rows[at + 1]) > levelOf(row));

  const row = (node: PresetNode): PresetNode => {
    const at = rows.indexOf(node);
    if (at === -1) return node;
    const parent = parents[at];
    const above = ancestors(at);
    const toParent: Trigger[] = parent ? [onKeys('parent', ['InlineStart'], { focus: parent.id })] : [];
    const shown = above.length > 0 ? { showWhen: above.length === 1 ? { state: openOf(above[0]), eq: true } : both(...above.map((a): Condition => ({ state: openOf(a), eq: true }))) } : {};
    if (!branches.includes(node)) return derived(node, { on: toParent, ...shown });
    const open = openOf(node);
    return derived(node, {
      bind: [{ attr: 'aria-expanded', from: { get: open } }],
      on: [
        { ...onKeys('enter', ['InlineEnd'], go('next')), if: { state: open, eq: true } },
        { ...onKeys('open', ['InlineEnd'], { set: open, value: true }), if: not(open) },
        ...toParent.map((trigger) => ({ ...trigger, if: not(open) })),
        { ...onKeys('close', ['InlineStart'], { set: open, value: false }), if: { state: open, eq: true } },
        onKeys('flip', ['Enter'], { toggle: open }),
      ],
      ...shown,
    });
  };

  return derived({
    ...root,
    children: root.children?.map((child) => (child === body
      ? derived({ ...body, children: body.children?.map(row) }, {
          group: { role: 'row', axis: 'line' },
          on: [
            onKeys('next', ['ArrowDown'], go('next')),
            onKeys('prev', ['ArrowUp'], go('prev')),
            onKeys('first', ['Home', 'Ctrl+Home'], go('first')),
            onKeys('last', ['End', 'Ctrl+End'], go('last')),
            { id: 'type', on: 'keydown', keys: ['Printable'], do: [go('type')] },
          ],
        })
      : child)),
  }, {
    state: branches.map((branch) => ({ id: openOf(branch), name: 'Row open', type: 'boolean' as const, initial: false })),
    preset: { kind: 'treegrid', version: TREE_VERSION },
  });
}

export function treegrid({ seed, label = 'Mail', columns = DEFAULT_COLUMNS, rows = [...DEFAULT_ROWS] }: TreegridOptions): PresetNode {
  assertSeed(seed);
  const flat: PresetNode[] = [];
  const walk = (entries: readonly TreegridEntry[], level: number, path: string) => entries.forEach((entry, at) => {
    const id = `${seed}-row-${path}${at}`;
    flat.push(el(id, 'tr', { role: 'row', 'aria-level': level, 'aria-setsize': entries.length, 'aria-posinset': at + 1 },
      ...entry.cells.map((cell, x) => el(`${id}-cell-${x}`, 'td', { role: 'gridcell', children: cell, style: { padding: '8px 12px', paddingInlineStart: x === 0 ? `${12 + (level - 1) * 16}px` : '12px' } }))));
    if (entry.children) walk(entry.children, level + 1, `${path}${at}-`);
  });
  walk(rows, 1, '');
  return deriveTreegrid(
    el(seed, 'table', { role: 'treegrid', 'aria-label': label, style: { borderCollapse: 'collapse', width: '100%' } },
      el(`${seed}-head`, 'thead', {},
        el(`${seed}-head-row`, 'tr', { role: 'row' }, ...columns.map((column, at) => el(`${seed}-column-${at}`, 'th', { role: 'columnheader', scope: 'col', children: column, style: { padding: '8px 12px', textAlign: 'start' } })))),
      el(`${seed}-body`, 'tbody', {}, ...flat)),
  );
}
