// src/components/live/AgentEditingNote.tsx
//
// The top bar's note while an agent works on the open site (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 1, "unsaved local edits"):
// "Claude is editing this site", so a person who starts editing knows a
// conflict may follow. Shown while a call runs and AGENT_ACTIVE_MS after the
// last one ended (src/lib/live/presenceStore.ts). Announced politely once when
// it appears. The compact bar (under 1024px) shows a dot with the sentence as
// its tooltip and for screen readers, so the notice is there on every layout.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { editingNote } from '@/lib/live/activityText';
import type { LivePresenceStore } from '@/lib/live/presenceStore';

const AgentEditingNote = observer(function AgentEditingNote({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const { editorUI } = useStore();
  const presence = editorUI.livePresence as LivePresenceStore | undefined;
  const note = editingNote((presence?.active ?? []).map((a) => a.label));
  return (
    // A polite live region, present before the note appears so it is announced (not role="status":
    // the save status next to it is the top bar's status).
    <span aria-live="polite" className={className}>
      {note && compact && (
        // The compact bar has no room for the sentence: a dot that carries it for a screen reader and as a tooltip.
        <span data-agent-editing-note="" title={note} className="inline-flex size-6 items-center justify-center">
          <span aria-hidden="true" className="block size-2 rounded-full bg-agent-presence" />
          <span className="sr-only">{note}</span>
        </span>
      )}
      {note && !compact && (
        <span
          data-agent-editing-note=""
          title={note}
          className="inline-flex max-w-[260px] items-center gap-1.5 truncate rounded-full border border-agent-presence/40 bg-agent-presence/10 px-2 py-0.5 text-xs font-medium text-foreground"
        >
          <span aria-hidden="true" className="block size-1.5 shrink-0 rounded-full bg-agent-presence" />
          <span className="truncate">{note}</span>
        </span>
      )}
    </span>
  );
});

AgentEditingNote.displayName = 'AgentEditingNote';
export default AgentEditingNote;
