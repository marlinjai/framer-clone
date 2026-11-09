// src/lib/live/editingInProgress.ts
//
// Whether the person is in the middle of something an agent's live write must
// not cut into (plan docs/plans/2026-11-08-live-agent-canvas.md; review findings
// F1 and H2 of 2026-11-09):
//
//   - editing: typing not in the project tree yet (the canvas's inline text
//     editor, a properties-panel field: src/lib/projects/openDrafts.ts), a text
//     edit open on the canvas, a drag or a resize whose patches are being
//     batched into one undo step. Adopting a newer copy now would replace the
//     node under the cursor, or the frame being dragged, so LiveSync holds the
//     copy (without the Site Changed dialog: nothing is unsaved yet) and looks
//     again once the editing settled.
//   - interacting: editing, or a marquee being drawn, or the focus in a field
//     of the canvas or a panel. The camera followers and the switch to an
//     agent's new page wait while the person does any of this.

import { reaction } from 'mobx';
import type { RootStoreType } from '@/stores/RootStore';
import { getHistoryStore } from '@/stores/RootStore';
import { hasOpenDrafts, onOpenDraftsChanged } from '@/lib/projects/openDrafts';
import { isEditableTarget } from '@/lib/keyBindings';

/** How often a hold looks again by itself, should a settle go unannounced (a draft whose owner never says). */
export const EDITING_RECHECK_MS = 1_000;

/** The observable part: a text edit, a resize, a batched gesture (drag, resize, a colour being dragged). */
function storeEditing(rootStore: RootStoreType): boolean {
  const ui = rootStore.editorUI;
  return !!ui.editingComponent || ui.isResizing || !!getHistoryStore()?.batch;
}

/** True while typing, a text edit, a drag or a resize is open: an adoption now would cut into it. */
export function isEditing(rootStore: RootStoreType): boolean {
  return storeEditing(rootStore) || hasOpenDrafts();
}

/** True while the focus is in a text field, a select or editable text (the canvas or a panel). */
export function focusInField(): boolean {
  if (typeof document === 'undefined') return false;
  return isEditableTarget(document.activeElement);
}

/** Editing, a marquee being drawn, or the focus in a field: the camera and the page stay where the person has them. */
export function isInteracting(rootStore: RootStoreType): boolean {
  return isEditing(rootStore) || rootStore.editorUI.marqueeActive || focusInField();
}

/**
 * Call `listener` once editing may have ended: a text edit, a resize or a
 * gesture ends (observed), a draft settles (announced), and every
 * EDITING_RECHECK_MS as a fallback. The listener checks isEditing itself.
 * Answers the unsubscribe.
 */
export function onEditingSettled(rootStore: RootStoreType, listener: () => void): () => void {
  const disposeReaction = reaction(
    () => storeEditing(rootStore),
    (editing) => {
      if (!editing) listener();
    },
  );
  const disposeDrafts = onOpenDraftsChanged(listener);
  const timer = setInterval(listener, EDITING_RECHECK_MS);
  return () => {
    disposeReaction();
    disposeDrafts();
    clearInterval(timer);
  };
}

/** The person's selection, as one comparable key (the primary first, then the rest, then a selected frame). */
function selectionKey(rootStore: RootStoreType): string {
  const ui = rootStore.editorUI;
  const ids = ui.selectedComponents.filter((c) => !!c).map((c) => c!.id);
  const frame = ui.selectedViewportNode?.id;
  return [...ids, frame ? `frame:${frame}` : ''].join('|');
}

/**
 * Call `listener` when the person takes over from a camera follower: they
 * select something else (a selection that only shrinks, as when an agent's
 * write removes a selected node, does not count, nor the page root a page
 * switch selects by itself) or start a text edit.
 * Answers the unsubscribe.
 */
export function onPersonTookOver(rootStore: RootStoreType, listener: () => void): () => void {
  const disposeSelection = reaction(
    () => ({ page: rootStore.editorUI.currentPage?.id, key: selectionKey(rootStore) }),
    (next, prev) => {
      // Showing another page selects its root by itself (setCurrentPage): the
      // switch to an agent's new page, or away from a page an agent deleted, is
      // not the person taking over.
      if (next.page !== prev.page) return;
      const before = new Set(prev.key.split('|').filter(Boolean));
      if (next.key.split('|').filter(Boolean).some((id) => !before.has(id))) listener();
    },
    { equals: (a, b) => a.page === b.page && a.key === b.key },
  );
  const disposeEdit = reaction(
    () => rootStore.editorUI.editingComponent?.id,
    (id) => {
      if (id) listener();
    },
  );
  return () => {
    disposeSelection();
    disposeEdit();
  };
}
