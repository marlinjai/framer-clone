// src/lib/layers/layerActions.ts
//
// Rules behind the Layers panel's row actions (hide, lock, delete) and the
// canvas checks that honour them, kept out of the components so they are unit
// tested.
//
// Semantics (decided to match Framer's layer panel):
//   - Hidden (`canvasVisible === false`) is an EDITOR-CANVAS toggle. The node
//     and its subtree disappear from the canvas, but preview and the published
//     page still render it. What the visitor sees is controlled by the
//     Visible switch in the Styles section (display: none), a separate thing.
//   - Locked (`canvasLocked === true`) applies to the node and everything
//     inside it: on the canvas they cannot be selected, dragged, resized or
//     picked by the marquee, and a click falls through to the nearest
//     unlocked ancestor. The Layers panel can still select and reorder them.
//   - Both flags are model props on the project tree, so toggling them is an
//     undoable step, saved with the project and synced to collaborators.

import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import type { EditorUIType } from '@/stores/EditorUIStore';
import type { HistoryStoreInstance } from '@/stores/HistoryStore';
import { deleteSelection } from '@/lib/canvas/deleteSelection';

type FindComponent = (id: string) => ComponentInstance | undefined;

/** Ids of the node's ancestors, nearest first (empty for a root or floating node). */
export function ancestorIdsOf(component: ComponentInstance, find: FindComponent): string[] {
  const out: string[] = [];
  const seen = new Set<string>([component.id]);
  let parentId = component.parentId as string | undefined;
  while (parentId && !seen.has(parentId)) {
    out.push(parentId);
    seen.add(parentId);
    parentId = find(parentId)?.parentId as string | undefined;
  }
  return out;
}

/** True when the node or one of its ancestors is locked: the canvas must not pick it. */
export function isLockedOnCanvas(component: ComponentInstance, find: FindComponent): boolean {
  if (component.canvasLocked) return true;
  return ancestorIdsOf(component, find).some(id => !!find(id)?.canvasLocked);
}

/** Whether a Layers row offers Delete: never the page root or a breakpoint frame. */
export function canDeleteLayer(component: ComponentInstance): boolean {
  if (component.isViewportNode) return false;
  return component.hasParent || component.isFloatingElement;
}

/** Whether a Layers row offers Duplicate: the same nodes Delete accepts. */
export const canDuplicateLayer = canDeleteLayer;

/**
 * Duplicate from a Layers row or Cmd+D. When the row is part of the selection
 * (or no row is given) every selected node is duplicated, skipping nodes whose
 * ancestor is also selected so a subtree is copied once; all copies form one
 * undo step and become the new selection, the first copy as primary.
 * Returns how many copies were made.
 */
export function duplicateLayer(
  page: PageModelType,
  editorUI: EditorUIType,
  history: HistoryStoreInstance | null,
  component?: ComponentInstance,
): number {
  const useSelection = !component || editorUI.isSelected(component.id);
  const candidates = useSelection ? editorUI.selectedComponentList : [component];
  const find: FindComponent = (id) => page.findComponent(id);
  const chosen = new Set(candidates.map((c: ComponentInstance) => c.id));
  const roots = candidates.filter(
    (c: ComponentInstance) => canDuplicateLayer(c) && !ancestorIdsOf(c, find).some(id => chosen.has(id)),
  );
  if (roots.length === 0) return 0;

  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  history?.startBatch('Duplicate');
  const copies: ComponentInstance[] = [];
  for (const node of roots) {
    const copy = page.duplicateComponent(node.id);
    if (copy) copies.push(copy);
  }
  history?.commitBatch();
  if (copies.length > 0) editorUI.setSelection(copies, breakpointId);
  return copies.length;
}

/**
 * Delete from a Layers row. When the row is part of the selection the whole
 * selection goes (one undo step, as Delete on the canvas). Otherwise only the
 * row's node goes, and whatever else is selected stays selected; if the node
 * held the primary selection inside it, the next selected node takes over.
 * Returns how many nodes were removed.
 */
export function deleteLayer(
  page: PageModelType,
  editorUI: EditorUIType,
  history: HistoryStoreInstance | null,
  component: ComponentInstance,
): number {
  if (!canDeleteLayer(component)) return 0;
  if (editorUI.isSelected(component.id)) return deleteSelection(page, editorUI, history);

  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  if (!page.deleteComponent(component.id)) return 0;
  // safeReference already dropped any selected node that lived inside the
  // deleted one. A missing primary with extras left is promoted, so the
  // properties panel and the HUD keep a node to show.
  const remaining = editorUI.selectedComponentList;
  if (!editorUI.selectedComponent && remaining.length > 0) {
    editorUI.setSelection(remaining, breakpointId);
  }
  return 1;
}
