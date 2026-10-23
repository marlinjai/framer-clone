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
