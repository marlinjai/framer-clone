// src/components/live/LiveConnectionStatus.tsx
//
// Whether the open editor still follows the site live (plan
// docs/plans/2026-11-08-live-agent-canvas.md; review finding H1 of 2026-11-09),
// beside the save status in the top bar. Says nothing while all is well. When a
// stream that was live goes down for more than a moment (LIVE_PAUSED_GRACE_MS, so
// a reconnect by itself does not flash), "Live updates paused, reconnecting…",
// and where an agent's streamed draft was dropped meanwhile, that it shows again
// once the connection is back. Once the stream is back, "Live updates back" for
// LIVE_BACK_MS. One polite live region that is always present, so a screen
// reader hears each change once.
'use client';

import React from 'react';
import { Radio } from 'lucide-react';
import { useLiveSyncState, type LiveSyncState } from '@/hooks/useLiveSyncState';

export const LIVE_PAUSED_GRACE_MS = 2_000;
export const LIVE_BACK_MS = 4_000;

export const LIVE_PAUSED_TEXT = 'Live updates paused, reconnecting…';
export const LIVE_BACK_TEXT = 'Live updates back';
export const LIVE_DRAFT_LOST_TEXT = "The agent's draft will show again once the connection is back.";

/** Down after having been live: the connection was lost (a browser without streams only ever polls). */
function isDown(state: LiveSyncState): boolean {
  return state.phase === 'polling' && state.wasLive;
}

/** The message for the state, with the grace before "paused" and the linger of "back". */
export function useLiveConnectionMessage(projectId: string | undefined): { text: string; tone: 'paused' | 'back' | 'none' } {
  const state = useLiveSyncState(projectId);
  const down = isDown(state);
  const [paused, setPaused] = React.useState(false);
  const [back, setBack] = React.useState(false);
  const pausedRef = React.useRef(false);
  pausedRef.current = paused;

  React.useEffect(() => {
    if (down) {
      setBack(false);
      const t = window.setTimeout(() => setPaused(true), LIVE_PAUSED_GRACE_MS);
      return () => window.clearTimeout(t);
    }
    // Back (live again) after having said paused: say so for a moment.
    if (pausedRef.current && state.phase === 'live') {
      setPaused(false);
      setBack(true);
      const t = window.setTimeout(() => setBack(false), LIVE_BACK_MS);
      return () => window.clearTimeout(t);
    }
    // Stopped, signed out (the save status says so) or gone: nothing to say here.
    setPaused(false);
    return undefined;
  }, [down, state.phase]);

  if (paused && down) return { text: state.draftLost ? `${LIVE_PAUSED_TEXT} ${LIVE_DRAFT_LOST_TEXT}` : LIVE_PAUSED_TEXT, tone: 'paused' };
  if (back) return { text: LIVE_BACK_TEXT, tone: 'back' };
  return { text: '', tone: 'none' };
}

export default function LiveConnectionStatus({ projectId }: { projectId: string | undefined }) {
  const { text, tone } = useLiveConnectionMessage(projectId);
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="live-connection-status"
      title={text || undefined}
      className={
        tone === 'none'
          ? 'sr-only'
          : `flex min-w-0 items-center gap-1 text-xs ${tone === 'paused' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'} animate-in fade-in duration-200 ease-out motion-reduce:animate-none`
      }
    >
      {tone !== 'none' ? <Radio size={14} aria-hidden className="shrink-0" /> : null}
      <span className="lg:max-w-[260px] lg:truncate max-md:sr-only">{text}</span>
      {/* A small screen keeps a short word in sight (a tooltip cannot be opened by touch); the full text is read out above. */}
      {tone !== 'none' ? <span aria-hidden className="whitespace-nowrap md:hidden">{tone === 'paused' ? 'Paused' : 'Back'}</span> : null}
    </span>
  );
}
