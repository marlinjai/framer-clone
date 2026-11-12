// src/components/live/AgentEditingNote.tsx
//
// The top bar's chip while an agent works on the open site (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 1, "unsaved local edits"),
// so a person who starts editing knows a conflict may follow.
//
// Compact by decision (docs/plans/2026-11-12-top-bar-fold.md): the agent dot in
// the presence colour and a short label ("Agent editing", "2 agents reading"),
// in a slot of its own beside the save status, never over it. The full sentence
// ("Claude is editing this site", with the agent's name and what it does) is the
// chip's tooltip, which hover and keyboard focus both open, and its description
// for a screen reader; the Agent activity feed keeps every step. Pressing the
// chip opens that feed. Under 1024px (`compact`) only the dot shows.
//
// Shown while a call runs and AGENT_ACTIVE_MS after the last one ended
// (src/lib/live/presenceStore.ts). Not a live region itself: the verb changes
// with every call, and the announcer (src/components/live/AgentAnnouncer.tsx)
// speaks the note once per run instead.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { activityMode, editingNote, type ActivityMode } from '@/lib/live/activityText';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import { BarTooltip } from '@/components/topbar/BarTooltip';

/** The chip's short words: "Agent editing", "2 agents reading". */
export function agentChipLabel(count: number, mode: ActivityMode): string {
  return `${count === 1 ? 'Agent' : `${count} agents`} ${mode}`;
}

const AgentEditingNote = observer(function AgentEditingNote({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const { editorUI } = useStore();
  const presence = editorUI.livePresence as LivePresenceStore | undefined;
  const describedBy = React.useId();
  const agents = (presence?.active ?? []).map((a) => ({ label: a.label, tool: a.focus.tool }));
  const edited = presence?.runEdited ?? false;
  const note = editingNote(agents, edited);
  const mode = activityMode(agents, edited);
  if (!note || !mode) return <span className={className} />;
  const label = agentChipLabel(agents.length, mode);
  const dot = <span aria-hidden="true" className="block size-2 shrink-0 rounded-full bg-agent-presence forced-colors:bg-[CanvasText]" />;
  return (
    <span className={`shrink-0 ${className}`}>
      <BarTooltip text={note}>
        <button
          type="button"
          data-agent-editing-note=""
          aria-label={label}
          aria-describedby={describedBy}
          // The feed is where every step stays: the chip opens it.
          onClick={() => presence?.setPanelOpen(true)}
          className={
            compact
              ? 'inline-flex size-8 items-center justify-center rounded text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'
              : 'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-agent-presence/40 bg-agent-presence/10 px-2.5 text-xs font-medium text-foreground hover:bg-agent-presence/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand forced-colors:border-[CanvasText]'
          }
        >
          {dot}
          {compact ? null : <span>{label}</span>}
          <span id={describedBy} className="sr-only">
            {note}
          </span>
        </button>
      </BarTooltip>
    </span>
  );
});

AgentEditingNote.displayName = 'AgentEditingNote';
export default AgentEditingNote;
