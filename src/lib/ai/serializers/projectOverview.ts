// src/lib/ai/serializers/projectOverview.ts
//
// Stable project-scope context: project name, page index, breakpoints.
// Goes in the cached system prefix — the model needs to know what pages
// exist and what the responsive design rails are, but those facts change
// rarely compared to the page tree itself.

import type { ProjectModelType } from '@/models/ProjectModel';
import { CanvasNodeType } from '@/models/ComponentModel';
import { normalize } from './normalize';

export type ProjectOverview = {
  breakpoints: Array<{ id: string; label: string; minWidth: number }>;
  // collections: [] reserved for Phase 2 (CMS data-bindings)
  name: string;
  pages: Array<{ id: string; name: string; slug: string }>;
  projectId: string;
};

/**
 * Collect a deduped, ordered list of breakpoints by walking every page's
 * viewport nodes. We dedupe on `breakpointId` because the editor stores
 * one viewport node per (page, breakpoint), so the same breakpoint id
 * appears on every page that has that viewport. Sorted by `minWidth`
 * ascending — that's the order the model expects (smallest → largest).
 */
function collectBreakpoints(
  project: ProjectModelType,
): Array<{ id: string; label: string; minWidth: number }> {
  const seen = new Map<string, { id: string; label: string; minWidth: number }>();
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
  return Array.from(seen.values()).sort((a, b) => a.minWidth - b.minWidth);
}

/**
 * Page list, sorted by id for determinism. (Pages don't have a canonical
 * display order in the model today; the Pages panel sorts by something
 * different, but the AI doesn't need UI order — it needs stable order.)
 */
function collectPages(
  project: ProjectModelType,
): Array<{ id: string; name: string; slug: string }> {
  return Array.from(project.pages.values())
    .map((p) => ({
      id: p.id,
      name: p.metadata.title,
      slug: p.slug,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Serialize the project's stable surface area. Caller is expected to
 * include this in the cached system prefix of the AI request.
 */
export function serializeProjectOverview(
  project: ProjectModelType,
): ProjectOverview {
  const out = {
    projectId: project.id,
    name: project.metadata.title,
    pages: collectPages(project),
    breakpoints: collectBreakpoints(project),
  };
  return normalize(out) as ProjectOverview;
}
