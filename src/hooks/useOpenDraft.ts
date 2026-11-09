// src/hooks/useOpenDraft.ts
//
// A properties-panel field that commits on blur or Enter keeps what is typed
// in a local draft until then, so autosave cannot see it (plan
// docs/plans/2026-11-04-editor-autosave.md). This registers the field as an
// open draft (src/lib/projects/openDrafts.ts) from the first keystroke until it
// commits or reverts: the unload warning counts it, Cmd/Ctrl+S and leaving the
// page commit it first, and a field that goes away with a draft open (the
// editor closed by browser Back, the selection moved) commits it on unmount.
//
//   const draftState = useOpenDraft(() => commit(draft));
//   onChange: draftState.edited(); in commit and on Escape: draftState.settled().
'use client';

import React from 'react';
import { noteOpenDraftsChanged, registerOpenDraft } from '@/lib/projects/openDrafts';

export interface OpenDraftState {
  /** The person typed: the field holds a draft. */
  edited(): void;
  /** The draft was committed or reverted. */
  settled(): void;
}

export function useOpenDraft(commit: () => void): OpenDraftState {
  const latest = React.useRef(commit);
  latest.current = commit;
  const dirty = React.useRef(false);
  const state = React.useMemo<OpenDraftState>(
    () => ({
      edited: () => {
        dirty.current = true;
      },
      settled: () => {
        if (!dirty.current) return;
        dirty.current = false;
        noteOpenDraftsChanged();
      },
    }),
    [],
  );
  React.useEffect(() => {
    const flush = () => {
      if (!dirty.current) return;
      dirty.current = false;
      latest.current();
    };
    const unregister = registerOpenDraft({ isDirty: () => dirty.current, commit: flush });
    return () => {
      unregister();
      flush();
    };
  }, []);
  return state;
}
