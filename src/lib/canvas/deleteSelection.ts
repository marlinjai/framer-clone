// src/lib/canvas/deleteSelection.ts
//
// Delete / Backspace on the canvas: remove every selected component as ONE
// undo step. Kept out of EditorApp's key handler so the batching rule is unit
// tested.

import type { PageModelType } from '@/models/PageModel';
import type { EditorUIType } from '@/stores/EditorUIStore';
import type { HistoryStoreInstance } from '@/stores/HistoryStore';
import type { KeyBindingActionId } from '@/lib/keyBindings';
import { runFxLayerAction } from '@/lib/layers/fxRows';

/**
 * Delete the selected components from the page. Returns how many were
 * removed. The page root and breakpoint frames are never deleted (the page
 * refuses them). Several nodes are wrapped in one history batch, so a single
 * undo brings them all back.
 */
export function deleteSelection(
  page: PageModelType,
  editorUI: EditorUIType,
  history: HistoryStoreInstance | null,
): number {
  // Snapshot the ids first: deleting the primary clears the selection
  // (PageModel.deleteComponent drops references to the node it destroys).
  const ids = editorUI.selectedComponentList.map(c => c.id);
  if (ids.length === 0) return 0;
  if (ids.length === 1) return page.deleteComponent(ids[0]) ? 1 : 0;

  let removed = 0;
  history?.startBatch('Delete components');
  try {
    for (const id of ids) {
      // A node can already be gone with an earlier one (it was nested inside
      // it); deleteComponent would only warn about it, so skip it.
      if (!page.findComponent(id)) continue;
      if (page.deleteComponent(id)) removed += 1;
    }
  } finally {
    history?.commitBatch();
  }
  editorUI.clearSelection();
  return removed;
}

/**
 * With a layer of an FX scene box picked in the Layers panel (`EditorUIStore.fxLayerPick`),
 * Delete, Cmd+D and Escape act on that LAYER, never on the box: Delete with the box selected
 * removes the box, and a picked layer must not inherit that. Also Alt+Up / Alt+Down (one
 * place within the layer's group) and F2 (rename). The Background pseudo-row cannot be
 * deleted, copied or moved, and its keys do nothing rather than fall through to the box.
 *
 * `swallowStale: false` is for buttons (the phone toolbar and menu): see below.
 *
 * Returns true when the key belongs to the picked layer (the caller then does nothing
 * else with it), false when no layer is picked and the key keeps its usual meaning.
 */
export function routeFxLayerShortcut(action: KeyBindingActionId, editorUI: EditorUIType, options: { swallowStale?: boolean } = {}): boolean {
  const pick = editorUI.fxLayerPick;
  const box = editorUI.selectedComponent;
  if (!pick || !box) {
    // A layer WAS picked and has since gone (an undo, another writer's save): the key was meant for
    // it, so it is swallowed once and the pick is dropped. It never falls through to the box.
    if (editorUI.selectedFxLayer && box && editorUI.selectedFxLayer.componentId === box.id) {
      editorUI.clearFxLayerPick();
      // A key is swallowed once (it may be a repeat or a double press meant for the layer). A button on
      // screen shows the box's own state (the layer is no longer picked), so its tap is the box's.
      return options.swallowStale !== false;
    }
    return false;
  }
  switch (action) {
    case 'clearSelection':
      editorUI.clearFxLayerPick();
      return true;
    case 'delete':
    case 'duplicate':
    case 'fxLayerForward':
    case 'fxLayerBackward':
    case 'renameLayer': {
      if (pick.kind !== 'layer') return true;
      if (action === 'renameLayer') editorUI.startFxLayerRename(box.id, pick.layerId);
      else if (action === 'delete') runFxLayerAction(box, editorUI, pick.layerId, { type: 'delete' });
      else if (action === 'duplicate') runFxLayerAction(box, editorUI, pick.layerId, { type: 'duplicate' });
      else runFxLayerAction(box, editorUI, pick.layerId, { type: 'move', delta: action === 'fxLayerForward' ? 1 : -1 });
      return true;
    }
    default:
      return false;
  }
}
