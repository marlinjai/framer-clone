// The tree merge (src/lib/siteMerge/tree.ts), rule by rule of the site branches plan, section 5.

import { describe, expect, it } from 'vitest';
import { mergeForest, type Forest, type TreeNode } from '../tree';
import { ConflictLog, type MergeAnswers } from '../types';

/** A node: `n('a', {text: 'x'}, [children])`. */
function n(id: string, props: Record<string, unknown> = {}, children?: TreeNode[]): TreeNode {
  return { id, type: 'div', componentType: 'host', props, ...(children ? { children } : {}) };
}

const forest = (root: TreeNode, canvas: TreeNode[] = []): Forest => ({ slots: { app: [root], canvas } });

function merge(base: Forest, main: Forest, branch: Forest, answers: MergeAnswers = {}) {
  const log = new ConflictLog(answers);
  const { forest: merged } = mergeForest(base, main, branch, 'page:home', log);
  return { merged, log };
}

/** The tree as `id(children)` text, for readable expectations. */
function shape(f: Forest): string {
  const draw = (node: TreeNode): string =>
    node.children && node.children.length ? `${node.id}(${(node.children as TreeNode[]).map(draw).join(' ')})` : node.id;
  return (f.slots.app ?? []).map(draw).join(' ');
}

function find(f: Forest, id: string): TreeNode | undefined {
  const visit = (node: TreeNode): TreeNode | undefined =>
    node.id === id ? node : ((node.children ?? []) as TreeNode[]).map(visit).find(Boolean);
  return [...(f.slots.app ?? []), ...(f.slots.canvas ?? [])].map(visit).find(Boolean);
}

const base = forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'red' } }), n('c', {}, [n('c1')])]));

describe('mergeForest', () => {
  it('nothing changed: the same tree', () => {
    const { merged, log } = merge(base, base, base);
    expect(merged).toEqual(base);
    expect(log.open).toEqual([]);
  });

  it('rule 1 and 3 per field: different props and style keys merge, the same key conflicts', () => {
    const main = forest(n('root', {}, [n('a', { text: 'A main' }), n('b', { text: 'B', style: { color: 'red', margin: 1 } }), n('c', {}, [n('c1')])]));
    const branch = forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'blue' } }), n('c', {}, [n('c1')])]));
    const { merged, log } = merge(base, main, branch);
    expect(find(merged, 'a')?.props).toEqual({ text: 'A main' });
    expect(find(merged, 'b')?.props).toEqual({ text: 'B', style: { color: 'blue', margin: 1 } });
    expect(log.open).toEqual([]);

    const clash = forest(n('root', {}, [n('a', { text: 'A branch' }), n('b', { text: 'B', style: { color: 'red' } }), n('c', {}, [n('c1')])]));
    const conflicted = merge(base, main, clash);
    expect(conflicted.log.open.map((c) => [c.kind, c.unit.id, c.path])).toEqual([['value', 'a', ['props', 'text']]]);
    // Main stands in until answered; the answer applies by id and fingerprint.
    expect(find(conflicted.merged, 'a')?.props).toEqual({ text: 'A main' });
    const [conflict] = conflicted.log.open;
    const answered = merge(base, main, clash, { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } });
    expect(find(answered.merged, 'a')?.props).toEqual({ text: 'A branch' });
    expect(answered.log.open).toEqual([]);
    // An answer given for other values no longer applies.
    const stale = merge(base, main, clash, { [conflict.id]: { fingerprint: 'other', pick: 'branch' } });
    expect(stale.log.open).toHaveLength(1);
  });

  it('a responsive value merges per breakpoint', () => {
    const b = forest(n('root', { style: { width: { base: '10px', bp1: '5px' } } }));
    const m = forest(n('root', { style: { width: { base: '20px', bp1: '5px' } } }));
    const r = forest(n('root', { style: { width: { base: '10px', bp1: '8px' } } }));
    const { merged, log } = merge(b, m, r);
    expect(merged.slots.app[0].props).toEqual({ style: { width: { base: '20px', bp1: '8px' } } });
    expect(log.open).toEqual([]);
  });

  it('rule 4: added on either side is kept, in the place it was added; added on both, both kept', () => {
    const main = forest(n('root', {}, [n('a', { text: 'A' }), n('m'), n('b', { text: 'B', style: { color: 'red' } }), n('c', {}, [n('c1')])]));
    const branch = forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'red' } }), n('r'), n('c', {}, [n('c1'), n('r2')])]));
    const { merged, log } = merge(base, main, branch);
    expect(shape(merged)).toBe('root(a m b r c(c1 r2))');
    expect(log.open).toEqual([]);
  });

  it('rule 4: the same id added on both sides with different content conflicts, equal content is taken once', () => {
    const add = (props: Record<string, unknown>) =>
      forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'red' } }), n('c', {}, [n('c1')]), n('x', props)]));
    expect(merge(base, add({ t: 1 }), add({ t: 1 })).log.open).toEqual([]);
    const { log } = merge(base, add({ t: 1 }), add({ t: 2 }));
    expect(log.open.map((c) => c.kind)).toEqual(['added-twice']);
  });

  it('rule 5: removed on one side, untouched on the other, goes', () => {
    const main = forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'red' } })]));
    const { merged, log } = merge(base, main, base);
    expect(shape(merged)).toBe('root(a b)');
    expect(log.open).toEqual([]);
  });

  it('rule 6: removed on one side, changed inside on the other, is one conflict on the removed part', () => {
    const main = forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'red' } })]));
    // The branch changed c1 inside c and added a child to c.
    const branch = forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'red' } }), n('c', {}, [n('c1', { text: 'new' }), n('c2')])]));
    const { merged, log } = merge(base, main, branch);
    expect(log.open.map((c) => [c.kind, c.unit.id, c.removedOn])).toEqual([['removed', 'c', 'main']]);
    // Main's side stands in: removed.
    expect(shape(merged)).toBe('root(a b)');
    const [conflict] = log.open;
    const kept = merge(base, main, branch, { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } });
    expect(shape(kept.merged)).toBe('root(a b c(c1 c2))');
    expect(find(kept.merged, 'c1')?.props).toEqual({ text: 'new' });
    // And the other way round: the branch removed what main changed.
    const mirrored = merge(base, branch, main);
    expect(mirrored.log.open.map((c) => [c.kind, c.removedOn])).toEqual([['removed', 'branch']]);
    expect(shape(mirrored.merged)).toBe('root(a b c(c1 c2))');
  });

  it('a node moved out of a part the other side removed is asked on its own', () => {
    const main = forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'red' } })]));
    const branch = forest(n('root', {}, [n('a', { text: 'A' }, [n('c1')]), n('b', { text: 'B', style: { color: 'red' } }), n('c')]));
    const { log } = merge(base, main, branch);
    expect(log.open.map((c) => [c.kind, c.unit.id]).sort()).toEqual([['removed', 'c'], ['removed', 'c1']]);
  });

  it('rule 7: a move on one side is taken; different moves conflict', () => {
    const moved = forest(n('root', {}, [n('a', { text: 'A' }, [n('c1')]), n('b', { text: 'B', style: { color: 'red' } }), n('c')]));
    expect(shape(merge(base, base, moved).merged)).toBe('root(a(c1) b c)');
    const elsewhere = forest(n('root', {}, [n('a', { text: 'A' }), n('b', { text: 'B', style: { color: 'red' } }, [n('c1')]), n('c')]));
    const { log } = merge(base, elsewhere, moved);
    expect(log.open.map((c) => [c.kind, c.unit.id])).toEqual([['moved', 'c1']]);
  });

  it('two moves that are fine alone but loop together are a cycle conflict', () => {
    const b = forest(n('root', {}, [n('x'), n('y')]));
    const m = forest(n('root', {}, [n('x', {}, [n('y')])]));
    const r = forest(n('root', {}, [n('y', {}, [n('x')])]));
    const { merged, log } = merge(b, m, r);
    expect(log.open.map((c) => c.kind)).toEqual(['cycle']);
    expect(shape(merged)).toBe('root(x(y))');
    const [conflict] = log.open;
    expect(shape(merge(b, m, r, { [conflict.id]: { fingerprint: conflict.fingerprint, pick: 'branch' } }).merged)).toBe('root(y(x))');
  });

  it('rule 8: one side reorders, the order is taken; both reorder differently, a conflict on the parent', () => {
    const order = (...ids: string[]) =>
      forest(n('root', {}, ids.map((id) => (id === 'c' ? n('c', {}, [n('c1')]) : id === 'b' ? n('b', { text: 'B', style: { color: 'red' } }) : n(id, { text: 'A' })))));
    expect(shape(merge(base, base, order('c', 'a', 'b')).merged)).toBe('root(c(c1) a b)');
    // The branch adds a node, main reorders: no conflict, the add follows its sibling.
    const added = forest(n('root', {}, [n('a', { text: 'A' }), n('new'), n('b', { text: 'B', style: { color: 'red' } }), n('c', {}, [n('c1')])]));
    const { merged, log } = merge(base, order('b', 'a', 'c'), added);
    expect(log.open).toEqual([]);
    expect(shape(merged)).toBe('root(b a new c(c1))');
    const both = merge(base, order('b', 'a', 'c'), order('c', 'b', 'a'));
    expect(both.log.open.map((c) => [c.kind, c.unit.id])).toEqual([['order', 'root']]);
    expect(shape(both.merged)).toBe('root(b a c(c1))');
  });

  it('canvas nodes have no order to conflict on', () => {
    const b = forest(n('root'), [n('v1'), n('v2')]);
    const m = forest(n('root'), [n('v2'), n('v1')]);
    const r = forest(n('root'), [n('v1'), n('v2'), n('v3')]);
    const { merged, log } = merge(b, m, r);
    expect(log.open).toEqual([]);
    expect(merged.slots.canvas.map((node) => node.id)).toEqual(['v2', 'v1', 'v3']);
  });

  it('conflict ids are stable and name the unit and part, never a position', () => {
    const main = forest(n('root', {}, [n('a', { text: 'M' }), n('b', { text: 'B', style: { color: 'red' } }), n('c', {}, [n('c1')])]));
    const branch = forest(n('root', {}, [n('b', { text: 'B', style: { color: 'red' } }), n('a', { text: 'R' }), n('c', {}, [n('c1')])]));
    const first = merge(base, main, branch).log.open.map((c) => c.id);
    expect(first).toContain('page:home|node:a|value|props|text');
    expect(merge(base, main, branch).log.open.map((c) => c.id)).toEqual(first);
  });
});
