// Types shared across the drag module.
//
// A DragSource is either:
//   - `create`: a new component to be inserted from the registry (panel item).
//   - `moveNode`: an existing node being reparented (tree child, floating
//      element, or viewport).
//
// DragMode decides whether the source follows the cursor in canvas space
// (`live`, e.g. floating / viewport position drag) or stays put while a ghost
// pill follows the cursor (`ghost`, e.g. tree child reparent + panel create).
// The resolver does NOT decide this — the manager sets mode at gesture start
// based on source type. The resolver only produces target + indicator.

import type { InsertTarget } from '@/models/PageModel';

export type DragSource =
  | { kind: 'create'; registryId: string }
  | { kind: 'moveNode'; nodeId: string };

export type DragMode = 'live' | 'ghost';

// What the DropIndicatorLayer paints this frame.
// `before` / `after` paint a horizontal bar flush to the target's edge.
// `inside` paints an outline on the target's bounding box.
// null means no indicator (either no valid target, or target kind is `floating`
// where the source itself is following the cursor in live mode).
export type IndicatorSpec =
  | { kind: 'before'; rect: DOMRect; targetId: string }
  | { kind: 'after'; rect: DOMRect; targetId: string }
  | { kind: 'inside'; rect: DOMRect; targetId: string }
  | null;

// Resolver output. `target === null` means "cancel silently" (UI chrome, self,
// descendant, or outside the known drop regions).
export interface ResolveDropTargetOutput {
  target: InsertTarget | null;
  indicator: IndicatorSpec;
}
