// src/lib/projects/openDrafts.ts
//
// Text being typed that is not in the project tree yet (plan
// docs/plans/2026-11-04-editor-autosave.md): the canvas's inline text editor
// and the properties panel's text field keep their draft until blur or Enter,
// so one edit is one undo step. Until then autosave cannot see it. Each open
// draft registers here, so that
//   - the unload warning counts it as unsaved work (UnsavedWorkGuard),
//   - Cmd/Ctrl+S commits it before saving (saveShortcut.ts),
//   - the save on leaving the page commits it first,
//   - the live sync holds an agent's newer copy until the typing settled
//     (src/lib/live/editingInProgress.ts): adopting it would replace the node
//     under the cursor.

export type CommitHow = 'end' | 'keep';

export interface OpenDraft {
  /** True while the typed text differs from the node's. */
  isDirty(): boolean;
  /**
   * Write the typed text into the node (one undo step, as blur or Enter would).
   * `end`: the edit may end with it (Cmd+S). `keep`: the person is still in the
   * middle of it (the tab is hidden, the page saves on its way out): commit
   * without ending the edit or moving the focus.
   */
  commit(how: CommitHow): void;
}

const drafts = new Set<OpenDraft>();
const changeListeners = new Set<() => void>();

/** Register an open draft; answers the function that removes it. */
export function registerOpenDraft(draft: OpenDraft): () => void {
  drafts.add(draft);
  return () => {
    if (drafts.delete(draft)) noteOpenDraftsChanged();
  };
}

/**
 * Hear when a draft may have settled (removed, committed or reverted): whoever
 * waits for the typing to end looks again. Answers the unsubscribe.
 */
export function onOpenDraftsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** A draft committed or reverted (its owner calls this; removing one and commitOpenDrafts do it themselves). */
export function noteOpenDraftsChanged(): void {
  // After the owner's own state update (a commit writes the node first).
  queueMicrotask(() => {
    for (const listener of [...changeListeners]) listener();
  });
}

/** True while any draft holds typing the project tree does not have yet. */
export function hasOpenDrafts(): boolean {
  for (const draft of drafts) if (draft.isDirty()) return true;
  return false;
}

/** Commit every dirty draft. One that fails is logged; the others still commit. */
export function commitOpenDrafts(how: CommitHow = 'end'): void {
  for (const draft of [...drafts]) {
    if (!draft.isDirty()) continue;
    try {
      draft.commit(how);
    } catch (err) {
      console.error('[editor] an open text draft could not be committed:', err);
    }
  }
  noteOpenDraftsChanged();
}
