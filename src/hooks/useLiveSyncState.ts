// src/hooks/useLiveSyncState.ts
//
// The live sync of a project (src/lib/projects/liveSync.ts) as React state: its
// phase, whether the stream was ever live, whether an agent's streamed draft was
// dropped while the stream was down, and the copy held for the person. Works
// before the sync starts (the top bar renders first) and across a restart.
'use client';

import React from 'react';
import { liveSyncFor, subscribeLiveSync, type HeldVersion, type LiveSyncPhase } from '@/lib/projects/liveSync';

export interface LiveSyncState {
  phase: LiveSyncPhase;
  wasLive: boolean;
  draftLost: boolean;
  held: HeldVersion | undefined;
}

const STOPPED: LiveSyncState = { phase: 'stopped', wasLive: false, draftLost: false, held: undefined };

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
    if (prev.phase === sync.phase && prev.wasLive === sync.wasLive && prev.draftLost === sync.draftLost && prev.held === sync.heldVersion) {
      return prev;
    }
    cache.current = { phase: sync.phase, wasLive: sync.wasLive, draftLost: sync.draftLost, held: sync.heldVersion };
    return cache.current;
  }, [projectId]);
  return React.useSyncExternalStore(subscribe, read, () => STOPPED);
}
