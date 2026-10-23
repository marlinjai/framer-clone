// src/lib/canvas/deleteSelection.ts
//
// Delete / Backspace on the canvas: remove every selected component as ONE
// undo step. Kept out of EditorApp's key handler so the batching rule is unit
// tested.

import type { PageModelType } from '@/models/PageModel';
import type { EditorUIType } from '@/stores/EditorUIStore';
import type { HistoryStoreInstance } from '@/stores/HistoryStore';

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
