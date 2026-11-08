// src/components/live/AgentPageDot.tsx
//
// The Pages panel's mark for a page an agent works on right now (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 2): a small dot in the
// agent presence blue, while that agent's frame shows. Static (no pulse); a
// screen reader hears "an agent is working here".
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { presencePageId, presencePagesOf, type PresenceProject } from '@/lib/live/presenceTarget';
import type { LivePresenceStore } from '@/lib/live/presenceStore';

/** The ids of the pages an agent's frame is on now. */
export function useAgentPageIds(): Set<string> {
  const { editorUI } = useStore();
  // Absent where an editor store is stubbed (tests): nothing is framed then.
  const presence = editorUI.livePresence as LivePresenceStore | undefined;
  const project = editorUI.currentProject;
  const pages = presencePagesOf(project as unknown as PresenceProject | undefined);
  const ids = new Set<string>();
  for (const agent of presence?.framed ?? []) {
    const pageId = presencePageId(pages, agent.focus);
    if (pageId) ids.add(pageId);
  }
  return ids;
}

const AgentPageDot = observer(function AgentPageDot({ pageId }: { pageId: string }) {
  const working = useAgentPageIds().has(pageId);
  if (!working) return null;
  return (
    <span data-agent-page-dot="" className="inline-flex shrink-0 items-center">
      <span aria-hidden="true" className="block size-1.5 rounded-full bg-agent-presence" />
      <span className="sr-only">(an agent is working here)</span>
    </span>
  );
});

AgentPageDot.displayName = 'AgentPageDot';
export default AgentPageDot;
