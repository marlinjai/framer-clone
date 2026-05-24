// src/lib/ai/serializers/tokenBudget.ts
//
// Pre-flight token estimation + tree truncation.
//
// We avoid round-tripping through Anthropic's tokenizer for two reasons:
//   1. The tokenizer is server-side; this code runs in the editor.
//   2. Even when we have the tokenizer, calling it on every keystroke
//      is wasteful. A ~4 chars/token approximation gets us within the
//      ballpark, which is all we need for budget guards.
//
// Truncation strategy: keep tree shape, drop the deepest children first.
// Rationale: structure + node identity is what the model needs to plan a
// mutation; the contents of leaf containers can usually be regenerated.
// We progressively shrink the allowed depth until the JSON fits.

/**
 * Well-known heuristic: ~4 chars per token. Slight over-estimate is
 * desirable (we'd rather truncate too aggressively than blow the context
 * window).
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

type WithChildren = { children?: WithChildren[] };

function maxDepthOf(n: WithChildren): number {
  const kids = n.children;
  if (!kids || kids.length === 0) return 0;
  let max = 0;
  for (const c of kids) {
    const d = maxDepthOf(c);
    if (d > max) max = d;
  }
  return 1 + max;
}

function pruneToDepth<T extends WithChildren>(n: T, depth: number): T {
  if (depth <= 0) {
    return { ...n, children: [] } as T;
  }
  const kids = n.children ?? [];
  return {
    ...n,
    children: kids.map((c) => pruneToDepth(c as WithChildren, depth - 1)),
  } as T;
}

/**
 * Shrink `tree` until its stringified form fits `maxTokens`. Operates by
 * progressively reducing the allowed depth — innermost leaves go first,
 * the root + its immediate children survive longest.
 *
 * Returns the input unchanged if it already fits.
 *
 * Generic in T but only the `children?: T[]` part of the shape is touched;
 * other fields are preserved.
 */
export function truncateTreeToBudget<T extends WithChildren>(
  tree: T,
  maxTokens: number,
): T {
  const measure = (t: T): number => estimateTokens(JSON.stringify(t));

  if (measure(tree) <= maxTokens) return tree;

  let depth = maxDepthOf(tree);
  let current: T = tree;
  while (depth > 0) {
    depth -= 1;
    current = pruneToDepth(tree, depth);
    if (measure(current) <= maxTokens) return current;
  }

  // Even the root alone exceeds budget — return the depth-0 version. The
  // caller is responsible for deciding whether to split the work or fail
  // loud.
  return pruneToDepth(tree, 0);
}
