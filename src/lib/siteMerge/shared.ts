// src/lib/siteMerge/shared.ts
//
// What the merge of site branches (docs/plans/2026-11-10-site-branches.md, section 5) and the live
// replay of a settled edit (src/lib/projects/liveSync.ts, rebaseEdit) share: every node of a document by
// id, a node of a loaded project by id, and the dry run of a change on a scratch copy with the size limit
// of a reusable component. One implementation, so the two never disagree on what a node is or what fits.
//
// Client and server safe: no React, no stores.

import { applyPatch, getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { COMPONENT_LIMITS, serializedBytes } from '@/lib/components/placement';

/** Every node of a snapshot's pages and components by id. */
export function nodesOf(snapshot: ProjectSnapshotOut): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { id?: unknown; children?: unknown };
    if (typeof n.id === 'string') out.set(n.id, node as Record<string, unknown>);
    if (Array.isArray(n.children)) n.children.forEach(visit);
  };
  const pages = [
    ...Object.values((snapshot.pages ?? {}) as Record<string, unknown>),
    ...Object.values((snapshot.components ?? {}) as Record<string, { page?: unknown }>).map((d) => d?.page),
  ] as Array<{ appComponentTree?: unknown; canvasNodes?: Record<string, unknown> } | undefined>;
  for (const page of pages) {
    visit(page?.appComponentTree);
    for (const node of Object.values(page?.canvasNodes ?? {})) visit(node);
  }
  return out;
}


/** A node of the open project by id (in any page or component). */
export function findNode(project: unknown, id: string): object | undefined {
  const pages = [
    ...((project as { pagesArray?: PageModelType[] }).pagesArray ?? []),
    ...Array.from(((project as { components?: Map<string, { page: PageModelType }> }).components ?? new Map()).values()).map((d) => d.page),
  ];
  const visit = (node: { id: string; children?: unknown[] } | undefined): object | undefined => {
    if (!node) return undefined;
    if (node.id === id) return node;
    for (const child of (node.children ?? []) as Array<{ id: string; children?: unknown[] }>) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  for (const page of pages) {
    const found = visit(page.appComponentTree as never);
    if (found) return found;
    for (const node of page.canvasNodes.values()) {
      const inCanvas = visit(node as never);
      if (inCanvas) return inCanvas;
    }
  }
  return undefined;
}

/**
 * The size rule of a reusable component, as the model applies it: over the limit is refused only when the
 * change made it bigger (one already too big may stay so, never grow).
 */
export function outgrewLimit(after: number, before: number): boolean {
  return after > COMPONENT_LIMITS.definitionBytes && after > before;
}

/** The edit applied to a scratch copy of the agent's version: true when every value applies and no reusable component outgrows its limit. */
export function replaysCleanly(snapshot: ProjectSnapshotOut, edits: Array<{ nodeId: string; field: string; value: unknown }>): boolean {
  try {
    const scratch = ProjectModel.create(snapshot);
    // The reusable components the edit touches, with their size before it (the model's own rule: one already too big may stay so, never grow).
    // A definition over the limit never loads (parseComponents refuses it on every path into the model), so this only ever meets growth past it.
    const touched = new Map<string, number>();
    for (const [id, definition] of scratch.components) {
      const ids = nodesOf({ pages: { p: getSnapshot(definition.page) } } as unknown as ProjectSnapshotOut);
      if (edits.some((edit) => ids.has(edit.nodeId))) touched.set(id, serializedBytes(getSnapshot(definition)));
    }
    for (const edit of edits) {
      const node = findNode(scratch, edit.nodeId);
      if (!node) return false;
      applyPatch(node, { op: 'replace', path: `/${edit.field}`, value: edit.value });
    }
    for (const [id, before] of touched) {
      const definition = scratch.components.get(id);
      const after = definition ? serializedBytes(getSnapshot(definition)) : 0;
      if (outgrewLimit(after, before)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

