// src/lib/live/reveal.ts
//
// The per-component reveal (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 4): which new nodes fade in, and when. Pure and client-safe, so the
// timing is tested without an editor; the live store (./revealStore.ts) holds
// the result and ComponentRenderer draws it as a Cascading Style Sheets (CSS)
// animation.
//
// Only element nodes take a place in the timing: a text node renders as plain
// text with no element to animate (it shows with its parent). Each page is
// timed on its own, so nodes created on another page never delay or compress
// the reveal of the page on screen.
//
// Timing (Emil Kowalski's rules): each node fades in with a 4px rise over
// REVEAL_NODE_MS, ease-out; REVEAL_GAP_MAX_MS between nodes, compressed so the
// whole batch is done within REVEAL_BATCH_MS:
//   gap = min(REVEAL_GAP_MAX_MS, (REVEAL_BATCH_MS - REVEAL_NODE_MS) / (n - 1))
// Order: document order, depth first, so a section's frame comes before its
// heading, the heading before the text, the text before the buttons.
//
// More than REVEAL_GROUP_ABOVE created nodes reveal by their top-level groups
// instead (the roots of the created subtrees, each carrying its subtree with
// it), so a large generated page does not crawl. A batch whose created nodes
// form one group (one big section) reveals that group and its direct created
// children, so it still unfolds rather than appearing as one block.

import { isTextNodeType } from '@/lib/renderer/textNode';

export const REVEAL_NODE_MS = 180;
export const REVEAL_GAP_MAX_MS = 45;
export const REVEAL_BATCH_MS = 600;
export const REVEAL_GROUP_ABOVE = 60;
/** The CSS keyframes every reveal plays (src/app/globals.css). */
export const REVEAL_KEYFRAMES = 'fc-live-reveal';
/** Marks an element that is revealing (the reduced-motion rule turns its animation off). */
export const REVEAL_ATTR = 'data-live-reveal';

/** The part of a component tree this module reads (a snapshot or a live node). */
export interface RevealTreeNode {
  id: string;
  /** The node's type; a text node (TEXT_NODE_TYPE) has no element of its own and is left out. */
  type?: unknown;
  children?: readonly RevealTreeNode[] | Iterable<RevealTreeNode>;
}

/** The gap between two nodes of a batch of `n`, in milliseconds. */
export function revealGap(n: number): number {
  if (n <= 1) return 0;
  return Math.min(REVEAL_GAP_MAX_MS, (REVEAL_BATCH_MS - REVEAL_NODE_MS) / (n - 1));
}

/** The delays of `n` nodes in order: 0, gap, 2 gap, ... (rounded to whole milliseconds). */
export function revealDelays(n: number): number[] {
  const gap = revealGap(n);
  return Array.from({ length: Math.max(0, n) }, (_, i) => Math.round(i * gap));
}

/** The CSS `animation` value of a node revealing after `delay` milliseconds. */
export function revealAnimation(delay: number): string {
  return `${REVEAL_KEYFRAMES} ${REVEAL_NODE_MS}ms ease-out ${Math.max(0, Math.round(delay))}ms backwards`;
}

interface Found {
  id: string;
  parentId: string | undefined;
  parentCreated: boolean;
}

function childrenOf(node: RevealTreeNode): RevealTreeNode[] {
  return node.children ? Array.from(node.children as Iterable<RevealTreeNode>) : [];
}

/**
 * Which of `created` reveal and after how long, walking `roots` depth first.
 * Ids not found in the trees are left out (a node already gone draws nothing).
 * The answer's order is the reveal order.
 */
export function revealPlan(roots: Iterable<RevealTreeNode | undefined | null>, created: Iterable<string>): Map<string, number> {
  const wanted = new Set(created);
  const found: Found[] = [];
  if (wanted.size > 0) {
    const visit = (node: RevealTreeNode, parent: RevealTreeNode | undefined) => {
      if (!node || typeof node.id !== 'string') return;
      if (isTextNodeType(node.type as string)) return;
      if (wanted.has(node.id)) {
        found.push({ id: node.id, parentId: parent?.id, parentCreated: !!parent && wanted.has(parent.id) });
      }
      for (const child of childrenOf(node)) visit(child, node);
    };
    for (const root of roots) if (root) visit(root, undefined);
  }
  let units: string[];
  if (found.length <= REVEAL_GROUP_ABOVE) {
    units = found.map((f) => f.id);
  } else {
    const groups = found.filter((f) => !f.parentCreated);
    if (groups.length === 1) {
      const only = groups[0].id;
      units = [only, ...found.filter((f) => f.parentId === only).map((f) => f.id)];
    } else {
      units = groups.map((f) => f.id);
    }
  }
  const delays = revealDelays(units.length);
  return new Map(units.map((id, i) => [id, delays[i]]));
}

/** The trees of each page of a project snapshot (the page's tree, then its floating elements), one list per page. */
export function projectRevealRoots(project: { pages?: unknown } | undefined): RevealTreeNode[][] {
  const pages = (project?.pages ?? {}) as Record<string, { appComponentTree?: RevealTreeNode; canvasNodes?: Record<string, RevealTreeNode> }>;
  return Object.values(pages).map((page) => {
    const roots: RevealTreeNode[] = [];
    if (page?.appComponentTree) roots.push(page.appComponentTree);
    for (const node of Object.values(page?.canvasNodes ?? {})) if (node) roots.push(node);
    return roots;
  });
}

/** The plan of an adopted copy: each page timed on its own (projectRevealRoots), merged. */
export function projectRevealPlan(project: { pages?: unknown } | undefined, created: readonly string[]): Map<string, number> {
  const plan = new Map<string, number>();
  if (created.length === 0) return plan;
  for (const roots of projectRevealRoots(project)) for (const [id, delay] of revealPlan(roots, created)) plan.set(id, delay);
  return plan;
}

/** Every id of the trees, depth first. */
export function subtreeIds(roots: Iterable<RevealTreeNode | undefined | null>): string[] {
  const ids: string[] = [];
  const visit = (node: RevealTreeNode) => {
    if (!node || typeof node.id !== 'string') return;
    if (isTextNodeType(node.type as string)) return;
    ids.push(node.id);
    for (const child of childrenOf(node)) visit(child);
  };
  for (const root of roots) if (root) visit(root);
  return ids;
}

/** The plan of whole trees that are all new (a generated section, a draft section). */
export function revealPlanOfTrees(roots: Iterable<RevealTreeNode | undefined | null>): Map<string, number> {
  const list = Array.from(roots);
  return revealPlan(list, subtreeIds(list));
}
