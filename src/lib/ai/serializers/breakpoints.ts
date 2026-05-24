// src/lib/ai/serializers/breakpoints.ts
//
// Breakpoint serializer. Pulls the deduped breakpoint list from the
// project's viewport nodes. Goes in the cached system prefix — the
// breakpoints define the responsive design rails and rarely change
// across an editing session.
//
// Implementation re-uses the same collection logic as
// `projectOverview.collectBreakpoints`, but exposes it directly so
// callers that only need the breakpoints don't have to construct an
// overview object.

import type { ProjectModelType } from '@/models/ProjectModel';
import { CanvasNodeType } from '@/models/ComponentModel';
import { normalize } from './normalize';

export type SerializedBreakpoint = {
  id: string;
  label: string;
  minWidth: number;
};

/**
 * Walk every viewport node across every page, deduped by `breakpointId`,
 * sorted ascending by `minWidth`. Stable order in, stable JSON out.
 */
export function serializeBreakpoints(
  project: ProjectModelType,
): SerializedBreakpoint[] {
  const seen = new Map<string, SerializedBreakpoint>();
  for (const page of project.pages.values()) {
    for (const node of page.canvasNodes.values()) {
      if (
        node.canvasNodeType === CanvasNodeType.VIEWPORT &&
        node.breakpointId
      ) {
        if (!seen.has(node.breakpointId)) {
          seen.set(node.breakpointId, {
            id: node.breakpointId,
            label: node.label ?? '',
            minWidth: node.breakpointMinWidth ?? 0,
          });
        }
      }
    }
  }
  const sorted = Array.from(seen.values()).sort(
    (a, b) => a.minWidth - b.minWidth,
  );
  return normalize(sorted) as SerializedBreakpoint[];
}
