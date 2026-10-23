// Layers fold state: a set of collapsed container ids, changed only through
// pure functions.
import { describe, it, expect } from 'vitest';
import {
  collapseAll,
  containerIds,
  expandAll,
  expandAncestors,
  toggleFold,
  toggleFoldSubtree,
  type FoldNode,
} from '../foldState';

// root > [section > [card > [text]], image]
const text: FoldNode = { id: 'text', children: [] };
const card: FoldNode = { id: 'card', children: [text] };
const section: FoldNode = { id: 'section', children: [card] };
const image: FoldNode = { id: 'image', children: [] };
const root: FoldNode = { id: 'root', children: [section, image] };
const floating: FoldNode = { id: 'floating', children: [{ id: 'badge', children: [] }] };

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('containerIds', () => {
  it('lists every node with children, never a leaf', () => {
    expect(containerIds(root).sort()).toEqual(['card', 'root', 'section']);
    expect(containerIds(text)).toEqual([]);
  });
});

describe('toggleFold', () => {
  it('folds an open row and opens a folded one, without touching the input', () => {
    const empty = new Set<string>();
    const folded = toggleFold(empty, 'section');
    expect(sorted(folded)).toEqual(['section']);
    expect(empty.size).toBe(0);
    expect(sorted(toggleFold(folded, 'section'))).toEqual([]);
  });
});

describe('toggleFoldSubtree (Alt+click)', () => {
  it('folds the row and every container below it', () => {
    expect(sorted(toggleFoldSubtree(new Set(), section))).toEqual(['card', 'section']);
  });

  it('opens the row and every container below it when the row was folded', () => {
    expect(sorted(toggleFoldSubtree(new Set(['section', 'card', 'root']), section))).toEqual(['root']);
  });
});

describe('collapseAll / expandAll', () => {
  it('fold and open every container of every tree, keeping other ids', () => {
    const all = collapseAll(new Set(['viewport-1']), [root, floating]);
    expect(sorted(all)).toEqual(['card', 'floating', 'root', 'section', 'viewport-1']);
    expect(sorted(expandAll(all, [root, floating]))).toEqual(['viewport-1']);
  });
});

describe('expandAncestors', () => {
  it('opens the given ancestors only', () => {
    const next = expandAncestors(new Set(['root', 'section', 'other']), ['section', 'root']);
    expect(sorted(next)).toEqual(['other']);
  });

  it('returns the same set when every ancestor is already open', () => {
    const current = new Set(['other']);
    expect(expandAncestors(current, ['section', 'root'])).toBe(current);
  });
});
