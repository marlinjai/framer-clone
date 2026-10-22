// src/lib/canvas/defaultViewports.ts
//
// The three breakpoint frames every page starts with (Desktop, Tablet,
// Mobile), defined once. Used by: a new page in the editor
// (ProjectModel.createPage), a new project (POST /api/projects), AI page
// generation (editorBridge), and the repair of pages that have NO frames,
// applied when a project is loaded (server/sites/snapshot.ts) and before an
// AI generation captures its target.
//
// Why the repair matters: a page without frames shows nothing on the editor
// canvas and "This page has no viewports defined" in Preview, and an AI
// generation into it keyed its Desktop/Tablet/Mobile styles to breakpoint ids
// no frame carries, so only the base styles ever rendered.

import { getSnapshot } from 'mobx-state-tree';
import {
  CanvasNodeType,
  createViewportNode,
  type ComponentSnapshotIn,
} from '@/models/ComponentModel';

export interface DefaultViewport {
  label: string;
  /** CSS min-width of the breakpoint. */
  minWidth: number;
  /** Canvas position and frame size (the height is the frame's minimum). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Widest first, laid out side by side on the canvas with a 50px gap. */
export const DEFAULT_VIEWPORTS: readonly DefaultViewport[] = Object.freeze([
  { label: 'Desktop', minWidth: 1280, x: 100, y: 100, width: 1280, height: 800 },
  { label: 'Tablet', minWidth: 768, x: 1430, y: 100, width: 768, height: 1024 },
  { label: 'Mobile', minWidth: 320, x: 2248, y: 100, width: 375, height: 667 },
]);

function newId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Snapshots of the three default frames, keyed by node id, with fresh
 * breakpoint ids (or the given ones, in DEFAULT_VIEWPORTS order).
 */
export function defaultViewportSnapshots(
  breakpointIds: readonly string[] = DEFAULT_VIEWPORTS.map(() => newId()),
): Record<string, ComponentSnapshotIn> {
  const out: Record<string, ComponentSnapshotIn> = {};
  DEFAULT_VIEWPORTS.forEach((v, i) => {
    const breakpointId = breakpointIds[i] ?? newId();
    const node = createViewportNode(
      `viewport-${breakpointId}`,
      breakpointId,
      v.label,
      v.minWidth,
      v.x,
      v.y,
      v.width,
      v.height,
    );
    out[node.id] = getSnapshot(node) as ComponentSnapshotIn;
  });
  return out;
}

/** True when a page's canvas nodes (snapshot or live map values) include a frame. */
export function hasViewport(canvasNodes: Iterable<{ canvasNodeType?: unknown }> | undefined): boolean {
  if (!canvasNodes) return false;
  for (const node of canvasNodes) {
    if (node && node.canvasNodeType === CanvasNodeType.VIEWPORT) return true;
  }
  return false;
}

/**
 * Breakpoint ids for frames REPAIRED onto an existing page, derived from the
 * page id: every load, in every tab, repairs the same page to the same frames,
 * so two tabs (or a load and a later save) never disagree about them.
 */
export function repairBreakpointIds(pageId: string): string[] {
  return DEFAULT_VIEWPORTS.map((v) => `${pageId}-${v.label.toLowerCase()}`);
}

/**
 * A page snapshot that renders: unchanged when it has at least one frame,
 * otherwise the same page plus the three default frames (its other canvas
 * nodes, such as floating elements, are kept). Pure and repeatable: never
 * mutates the input, and the same page always gets the same frame ids.
 */
export function withDefaultViewports<P extends { id?: unknown; canvasNodes?: unknown }>(page: P): P {
  // A stored page snapshot's canvas nodes are a plain id -> node object.
  const nodes = (page.canvasNodes ?? {}) as Record<string, { canvasNodeType?: unknown }>;
  if (hasViewport(Object.values(nodes))) return page;
  const ids = typeof page.id === 'string' && page.id ? repairBreakpointIds(page.id) : undefined;
  return { ...page, canvasNodes: { ...nodes, ...defaultViewportSnapshots(ids) } };
}
