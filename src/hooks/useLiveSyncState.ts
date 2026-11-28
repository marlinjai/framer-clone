// src/hooks/useLiveSyncState.ts
//
// The live sync of a project (src/lib/projects/liveSync.ts) as React state: its
// phase, whether the stream was ever live, whether an agent's streamed draft was
// dropped while the stream was down, whether the last answer of the document route
// could not be read, and the copy held for the person. Works
// before the sync starts (the top bar renders first) and across a restart.
'use client';

import React from 'react';
import { liveSyncFor, subscribeLiveSync, type HeldVersion, type LiveSyncPhase } from '@/lib/projects/liveSync';

export interface LiveSyncState {
  phase: LiveSyncPhase;
  wasLive: boolean;
  draftLost: boolean;
  /** The document route's last answer was not a document of this site (src/lib/projects/liveSync.ts, documentBodyOf). */
  unreadable: boolean;
  held: HeldVersion | undefined;
}

const STOPPED: LiveSyncState = { phase: 'stopped', wasLive: false, draftLost: false, unreadable: false, held: undefined };

export function useLiveSyncState(projectId: string | undefined): LiveSyncState {
  const cache = React.useRef<LiveSyncState>(STOPPED);
  const subscribe = React.useCallback(
    (listener: () => void) => (projectId ? subscribeLiveSync(projectId, listener) : () => {}),
    [projectId],
  );
  const read = React.useCallback((): LiveSyncState => {
    const sync = liveSyncFor(projectId);
    if (!sync) return STOPPED;
    const prev = cache.current;
    if (prev.phase === sync.phase && prev.wasLive === sync.wasLive && prev.draftLost === sync.draftLost && prev.unreadable === sync.unreadable && prev.held === sync.heldVersion) {
      return prev;
    }
    cache.current = { phase: sync.phase, wasLive: sync.wasLive, draftLost: sync.draftLost, unreadable: sync.unreadable, held: sync.heldVersion };
    return cache.current;
  }, [projectId]);
  return React.useSyncExternalStore(subscribe, read, () => STOPPED);
}
// ci-replay touch
