// src/lib/projects/openDrafts.ts
//
// Text being typed that is not in the project tree yet (plan
// docs/plans/2026-11-04-editor-autosave.md): the canvas's inline text editor
// and the properties panel's text field keep their draft until blur or Enter,
// so one edit is one undo step. Until then autosave cannot see it. Each open
// draft registers here, so that
//   - the unload warning counts it as unsaved work (UnsavedWorkGuard),
//   - Cmd/Ctrl+S commits it before saving (saveShortcut.ts),
//   - the save on leaving the page commits it first.

export interface OpenDraft {
  /** True while the typed text differs from the node's. */
  isDirty(): boolean;
  /** Write the typed text into the node (one undo step, as blur or Enter would). */
  commit(): void;
}

const drafts = new Set<OpenDraft>();

/** Register an open draft; answers the function that removes it. */
export function registerOpenDraft(draft: OpenDraft): () => void {
  drafts.add(draft);
  return () => {
    drafts.delete(draft);
  };
}

/** True while any draft holds typing the project tree does not have yet. */
export function hasOpenDrafts(): boolean {
  for (const draft of drafts) if (draft.isDirty()) return true;
  return false;
}

/** Commit every dirty draft. One that fails is logged; the others still commit. */
export function commitOpenDrafts(): void {
  for (const draft of [...drafts]) {
    if (!draft.isDirty()) continue;
    try {
      draft.commit();
    } catch (err) {
      console.error('[editor] an open text draft could not be committed:', err);
    }
  }
}
