// src/hooks/useInteracting.ts
//
// isInteracting (src/lib/live/editingInProgress.ts) as React state: true while
// the person types, edits text, drags, resizes, draws a marquee or has the focus
// in a field. The camera followers of the live canvas wait while it is true and
// look again when it turns false.
'use client';

import React from 'react';
import { reaction } from 'mobx';
import type { RootStoreType } from '@/stores/RootStore';
import { isInteracting } from '@/lib/live/editingInProgress';
import { onOpenDraftsChanged } from '@/lib/projects/openDrafts';

export function useInteracting(rootStore: RootStoreType): boolean {
  const [interacting, setInteracting] = React.useState(() => isInteracting(rootStore));
  React.useEffect(() => {
    const look = () => setInteracting(isInteracting(rootStore));
    // The observable parts (a text edit, a resize, a gesture, a marquee).
    const disposeReaction = reaction(() => isInteracting(rootStore), look);
    const disposeDrafts = onOpenDraftsChanged(look);
    // The focus entering or leaving a field; focusout fires before the focus moves, so look after it.
    const onFocus = () => queueMicrotask(look);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onFocus);
    look();
    return () => {
      disposeReaction();
      disposeDrafts();
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onFocus);
    };
  }, [rootStore]);
  return interacting;
}
