// src/lib/ai/serializers/__tests__/tokenBudget.test.ts

import { describe, it, expect } from 'vitest';

import { estimateTokens, truncateTreeToBudget } from '../tokenBudget';
import type { SerializedComponent } from '../subtree';

describe('estimateTokens', () => {
  it('approximates "hello world" at ~3 tokens', () => {
    // 11 chars / 4 = 2.75 → ceil = 3
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('scales linearly with length', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});

// Helper: build a balanced tree of given depth so we can predict
// truncation behaviour. Each non-leaf node has `branch` children of the
// next depth. Leaf nodes inflate `id` with padding so we can dial the
// per-node size and force truncation at known token counts.
function buildTree(depth: number, branch = 2, padding = 100): SerializedComponent {
  const id = `n-${depth}-${'x'.repeat(padding)}`;
  if (depth === 0) {
    return {
      canvasNodeType: 'component',
      children: [],
      componentType: 'host',
      id,
      props: {},
      type: 'div',
    };
  }
  const children: SerializedComponent[] = [];
  for (let i = 0; i < branch; i++) {
    children.push(buildTree(depth - 1, branch, padding));
  }
  return {
    canvasNodeType: 'component',
    children,
    componentType: 'host',
    id,
    props: {},
    type: 'div',
  };
}

describe('truncateTreeToBudget', () => {
  it('returns input untouched when already under budget', () => {
    const tree = buildTree(2, 2, 10);
    const out = truncateTreeToBudget(tree, 100_000);
    expect(out).toBe(tree);
  });

  it('drops the deepest level first when over budget', () => {
    const tree = buildTree(3, 2, 50);
    const fullDepthTokens = estimateTokens(JSON.stringify(tree));
    // Pick a budget that the depth-3 tree exceeds but a depth-2 one fits.
    const trimmedDepth2 = (() => {
      // Build the same shape pruned to depth 2 and measure.
      const t = buildTree(2, 2, 50);
      return estimateTokens(JSON.stringify(t));
    })();
    const budget = Math.floor((fullDepthTokens + trimmedDepth2) / 2);
    expect(budget).toBeLessThan(fullDepthTokens);
    expect(budget).toBeGreaterThan(trimmedDepth2);

    const out = truncateTreeToBudget(tree, budget);
    // Root + level-1 + level-2 retained, level-3 leaves dropped.
    expect(out.children.length).toBeGreaterThan(0);
    for (const lvl1 of out.children) {
      expect(lvl1.children.length).toBeGreaterThan(0);
      for (const lvl2 of lvl1.children) {
        expect(lvl2.children.length).toBe(0);
      }
    }
  });

  it('falls back to depth-0 when even the root + immediate children blow the budget', () => {
    const tree = buildTree(3, 4, 200);
    const out = truncateTreeToBudget(tree, 5); // absurdly small
    // Cannot reasonably fit; expect leaves stripped at every level.
    expect(out.children.length).toBe(0);
  });
});
