// src/lib/ai/review/placementOps.ts
//
// What a review may do to a placement of one of the site's components (see "AI
// generation" in docs/plans/2026-11-02-reusable-components.md). A placement's style
// is its own, how it sits on the page, so `update_style` writes it there, and a
// placement can be removed like any node. What is inside it is the definition's,
// shared by every placement on every page: a change there has a reach the review
// cannot see, so the review never edits it. The tree it reads holds only the
// placement, never the definition's nodes, and text on the placement is refused.

import { isPlacementType } from '@/lib/components/placement';

/** Why this operation may not run on a node of this type, or null. */
export function placementOpRefusal(type: string, op: unknown): string | null {
  if (!isPlacementType(type)) return null;
  if (op === 'update_style' || op === 'remove_node') return null;
  return "a component's content is its definition's, shared by every placement: suggest the change in your summary instead";
}
