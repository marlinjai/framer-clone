// reveal.ts: which new nodes fade in and when (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 4): document order depth first, 45 ms apart compressed into 600 ms,
// and top-level groups above 60 created nodes.
import { describe, expect, it } from 'vitest';
import {
  REVEAL_BATCH_MS,
  REVEAL_GAP_MAX_MS,
  REVEAL_GROUP_ABOVE,
  REVEAL_NODE_MS,
  projectRevealPlan,
  projectRevealRoots,
  revealAnimation,
  revealDelays,
  revealGap,
  revealPlan,
  revealPlanOfTrees,
  subtreeIds,
  subtreeIdsInProject,
  type RevealTreeNode,
} from '../reveal';

const node = (id: string, ...children: RevealTreeNode[]): RevealTreeNode => ({ id, children });

/** A section with `n` leaves. */
const section = (id: string, n: number) => node(id, ...Array.from({ length: n }, (_, i) => node(`${id}-${i}`)));

describe('revealGap and revealDelays', () => {
  it('45 ms apart while that fits, compressed so the batch ends within 600 ms', () => {
    expect(revealGap(0)).toBe(0);
    expect(revealGap(1)).toBe(0);
    expect(revealGap(2)).toBe(REVEAL_GAP_MAX_MS);
    // (600 - 180) / 45 = 9.33: up to 10 nodes keep the full gap.
    expect(revealGap(10)).toBe(45);
    expect(revealGap(11)).toBe(42);
    expect(revealGap(61)).toBe(7);
    for (const n of [2, 5, 10, 11, 30, 60, 61, 500]) {
      const delays = revealDelays(n);
      expect(delays).toHaveLength(n);
      expect(delays[0]).toBe(0);
      expect(delays[n - 1] + REVEAL_NODE_MS).toBeLessThanOrEqual(REVEAL_BATCH_MS);
      // Strictly in order.
      for (let i = 1; i < n; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    expect(revealDelays(4)).toEqual([0, 45, 90, 135]);
    expect(revealDelays(1)).toEqual([0]);
    expect(revealDelays(0)).toEqual([]);
  });

  it('writes the CSS animation of a delay', () => {
    expect(revealAnimation(90)).toBe('fc-live-reveal 180ms ease-out 90ms backwards');
    expect(revealAnimation(-5)).toBe('fc-live-reveal 180ms ease-out 0ms backwards');
  });
});

describe('revealPlan', () => {
  it('orders depth first: the section, then its heading, the heading text, then the next child', () => {
    const tree = node('root', node('old'), node('sec', node('h', node('h-text')), node('p'), node('btn')));
    const plan = revealPlan([tree], ['btn', 'p', 'sec', 'h-text', 'h']);
    expect([...plan.keys()]).toEqual(['sec', 'h', 'h-text', 'p', 'btn']);
    expect([...plan.values()]).toEqual([0, 45, 90, 135, 180]);
  });

  it('leaves out ids that are not in the trees, and plans nothing for nothing', () => {
    expect([...revealPlan([node('root', node('a'))], ['a', 'gone']).keys()]).toEqual(['a']);
    expect(revealPlan([node('root')], []).size).toBe(0);
    expect(revealPlan([undefined, null], ['a']).size).toBe(0);
  });

  it(`up to ${REVEAL_GROUP_ABOVE} created nodes reveal one by one`, () => {
    const roots = [node('root', section('a', 29), section('b', 29))];
    const created = subtreeIds(roots[0].children as RevealTreeNode[]);
    expect(created).toHaveLength(60);
    const plan = revealPlan(roots, created);
    expect(plan.size).toBe(60);
    expect(Math.max(...plan.values()) + REVEAL_NODE_MS).toBeLessThanOrEqual(REVEAL_BATCH_MS);
  });

  it(`above ${REVEAL_GROUP_ABOVE} they reveal by top-level group, each carrying its subtree`, () => {
    const sections = [section('a', 20), section('b', 20), section('c', 20)];
    const roots = [node('root', ...sections)];
    const plan = revealPlan(roots, subtreeIds(sections));
    expect([...plan.entries()]).toEqual([
      ['a', 0],
      ['b', 45],
      ['c', 90],
    ]);
  });

  it('one big group reveals with its direct created children, so it still unfolds', () => {
    const big = node('big', section('x', 30), section('y', 30), node('z'));
    const plan = revealPlan([node('root', big)], subtreeIds([big]));
    expect([...plan.keys()]).toEqual(['big', 'x', 'y', 'z']);
  });

  it('times each page of a project snapshot on its own: its tree, then its floating elements', () => {
    const project = {
      pages: {
        home: { appComponentTree: node('root', node('a')), canvasNodes: { f: node('float', node('f-child')) } },
        about: { appComponentTree: node('root2', node('b')) },
      },
    };
    expect(projectRevealRoots(project)).toHaveLength(2);
    const plan = projectRevealPlan(project, ['f-child', 'b', 'a']);
    // b, on another page, starts at 0 too: it never delays the page on screen.
    expect([...plan.entries()]).toEqual([['a', 0], ['f-child', 45], ['b', 0]]);
    expect(projectRevealRoots(undefined)).toEqual([]);
    expect(projectRevealPlan(project, []).size).toBe(0);
  });

  it('leaves text nodes out of the timing: they show with their parent', () => {
    const tree = node('root', { id: 'p', type: 'p', children: [{ id: 't1', type: '#text' }, { id: 'em', type: 'em', children: [{ id: 't2', type: '#text' }] }] });
    expect([...revealPlan([tree], ['p', 't1', 'em', 't2']).entries()]).toEqual([['p', 0], ['em', 45]]);
    expect(subtreeIds([tree])).toEqual(['root', 'p', 'em']);
  });

  it('revealPlanOfTrees plans every node of whole new trees', () => {
    expect([...revealPlanOfTrees([node('s', node('t')), undefined]).keys()]).toEqual(['s', 't']);
  });
});

describe('subtreeIdsInProject', () => {
  it('collects the subtrees rooted at the named ids on every page, text nodes left out', () => {
    const project = {
      pages: {
        a: { appComponentTree: { id: 'root', type: 'div', children: [{ id: 's1', type: 'section', children: [{ id: 'h', type: 'h2', children: [] }, { id: 't', type: '#text', children: [] }] }, { id: 's2', type: 'section', children: [] }] } },
        b: { appComponentTree: { id: 'root-b', type: 'div', children: [{ id: 's3', type: 'section', children: [] }] }, canvasNodes: { f: { id: 'f', type: 'div', children: [] } } },
      },
    };
    expect(subtreeIdsInProject(project, ['s1', 's3', 'missing'])).toEqual(['s1', 'h', 's3']);
    expect(subtreeIdsInProject(project, [])).toEqual([]);
  });
});
