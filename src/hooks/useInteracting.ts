// src/hooks/useInteracting.ts
//
// isInteracting (src/lib/live/editingInProgress.ts) as React state: true while
// the person types, edits text, drags, resizes, draws a marquee or types in a
// field. The camera followers of the live canvas wait while it is true and
// look again when it turns false.
'use client';

import React from 'react';
import { reaction } from 'mobx';
import type { RootStoreType } from '@/stores/RootStore';
import { FIELD_TYPING_IDLE_MS, isInteracting } from '@/lib/live/editingInProgress';
import { onOpenDraftsChanged } from '@/lib/projects/openDrafts';

export function useInteracting(rootStore: RootStoreType): boolean {
  const [interacting, setInteracting] = React.useState(() => isInteracting(rootStore));
  React.useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const now = isInteracting(rootStore);
      setInteracting(now);
      // Typing in a field ends by going quiet, which no event says: look again once it would have.
      if (idle) clearTimeout(idle);
      idle = now ? setTimeout(look, FIELD_TYPING_IDLE_MS) : undefined;
    };
    // The observable parts (a text edit, a resize, a gesture, a marquee).
    const disposeReaction = reaction(() => isInteracting(rootStore), look);
    const disposeDrafts = onOpenDraftsChanged(look);
    // The focus entering or leaving a field; focusout fires before the focus moves, so look after it.
    const onFocus = () => queueMicrotask(look);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onFocus);
    document.addEventListener('input', onFocus, true);
    // Arrow, Home and End keys move through a field without an input event, yet still note the typing time.
    document.addEventListener('keydown', onFocus, true);
    look();
    return () => {
      disposeReaction();
      disposeDrafts();
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onFocus);
      document.removeEventListener('input', onFocus, true);
      document.removeEventListener('keydown', onFocus, true);
      if (idle) clearTimeout(idle);
    };
  }, [rootStore]);
  return interacting;
}
