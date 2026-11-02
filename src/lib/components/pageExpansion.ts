// src/lib/components/pageExpansion.ts
//
// What the editor surfaces read of a page's placements: the same expansion the
// published page runs, with one budget across the page, so a canvas refuses what a
// visitor would not get, and a preview draws what a visitor would get. Memoised by
// `PageModel.expansion`, which recomputes when the page or a definition changes.
//
// PURE: no React, no MST. Client and server safe.

import type { ComponentDefinitions } from './definition';
import { createRenderBudget, expandPlacements } from './expand';
import { isMissingType } from './placement';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { componentSnapshotToNode, type ComponentSnapshotLike } from '@/lib/renderer/server/componentSnapshot';
import type { BreakpointRef } from '@/lib/responsive/cascade';

export interface PageExpansion {
  root: ComponentNode;
  floating: ComponentNode[];
  /** Every expanded placement, or its `#missing` node, by its expanded id. */
  placements: ReadonlyMap<string, ComponentNode>;
  /** The expanded ids of the placements that render nothing. */
  missing: ReadonlySet<string>;
}

function collect(node: ComponentNode, placements: Map<string, ComponentNode>, missing: Set<string>): void {
  if (node.id && (node.placementRoot || isMissingType(node.type))) placements.set(node.id, node);
  if (node.id && isMissingType(node.type)) missing.add(node.id);
  for (const child of node.children ?? []) collect(child, placements, missing);
}

export function expandPage(
  tree: ComponentSnapshotLike,
  floating: readonly ComponentSnapshotLike[],
  definitions: ComponentDefinitions,
  breakpoints: readonly BreakpointRef[],
): PageExpansion {
  const budget = createRenderBudget();
  const expand = (snapshot: ComponentSnapshotLike) =>
    expandPlacements(componentSnapshotToNode(snapshot), definitions, breakpoints, { budget });
  const expansion = { root: expand(tree), floating: floating.map(expand) };
  const placements = new Map<string, ComponentNode>();
  const missing = new Set<string>();
  for (const root of [expansion.root, ...expansion.floating]) collect(root, placements, missing);
  return { ...expansion, placements, missing };
}

/** The trees to scan for fonts: a family passed as an input counts, and a hidden node does not. */
export function literalPageRoots(
  trees: readonly ComponentSnapshotLike[],
  definitions: ComponentDefinitions,
  breakpoints: readonly BreakpointRef[],
): ComponentNode[] {
  const budget = createRenderBudget();
  return trees.map(tree => expandPlacements(componentSnapshotToNode(tree), definitions, breakpoints, { budget, literalInputs: true }));
}
