// src/components/live/AgentActivityPanel.tsx
//
// "Agent activity", the feed of the live agent canvas (plan
// docs/plans/2026-11-08-live-agent-canvas.md, section 2): a collapsible panel at
// the foot of the editor's left sidebar, newest line first. One line per call:
// the time, the agent's label, what it did in plain words ("Read the page
// ‘Home’", "Wrote 4 changes on ‘Home’", "Deleted the page ‘About’", "Changes
// refused, nothing written") and a status mark. Writes come back after a
// reload from the audit rows; reads exist only live
// (src/lib/live/presenceStore.ts). What a screen reader hears as lines arrive
// is the announcer's (src/components/live/AgentAnnouncer.tsx).
//
// Clicking a line whose nodes still exist opens their page, selects them and
// brings them into view; a line that names only a page opens the page; a line
// whose nodes are all gone is plain text. The
// Follow toggle turns the camera's following of the agent back on.
//
// It stays out of the way: absent until an agent was active in this session or
// the site has feed lines, and it opens by itself the first time an agent
// becomes active.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Clock, Crosshair, X } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import { revealOffset } from '@/lib/canvas/cameraControls';
import { feedLineText, feedLineTime, followTitle } from '@/lib/live/activityText';
import { rememberedPageTitle, rememberPageTitles } from '@/lib/live/pageTitleMemory';
import { noteFollowToggledByPerson } from '@/components/live/AgentAnnouncer';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import { presencePagesOf, type PresenceProject } from '@/lib/live/presenceTarget';
import type { LiveFeedLine } from '@/lib/projects/liveEvents';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';

/** The page and the nodes of a line that still exist in the open copy. */
export function lineTarget(
  pages: Iterable<PageModelType>,
  line: Pick<LiveFeedLine, 'pageId' | 'nodeIds'>,
): { page: PageModelType; nodes: ComponentInstance[] } | undefined {
  const all = Array.from(pages);
  const ids = line.nodeIds ?? [];
  const named = line.pageId ? all.find((p) => p.id === line.pageId) : undefined;
  // A line that names a page and no node (a page read, a page created) opens the page.
  if (ids.length === 0) return named ? { page: named, nodes: [] } : undefined;
  for (const page of named ? [named, ...all.filter((p) => p !== named)] : all) {
    const nodes = ids
      .map((id) => page.findComponent(id))
      .filter((n): n is ComponentInstance => !!n && n.id !== (page.appComponentTree as ComponentInstance).id);
    if (nodes.length > 0) return { page, nodes };
  }
  return undefined;
}

/** The frame of a page the selection should be made in: the one already chosen if the page has it, else its first. */
export function breakpointFor(page: PageModelType, preferred?: string): string | undefined {
  const viewports = page.viewportNodes as Array<{ breakpointId?: string }>;
  if (preferred && viewports.some((v) => v.breakpointId === preferred)) return preferred;
  return viewports.find((v) => v.breakpointId)?.breakpointId;
}

/** The amber of a refusal or a wait: darker in light mode, where the status token is under 3:1 on white. */
const WARNING_CLASS = 'text-amber-700 dark:text-status-draft';

/** The line's status mark: an image with its name, so a screen reader says it in the line. */
function StatusMark({ outcome }: { outcome: LiveFeedLine['outcome'] }) {
  if (outcome === 'ok') return <Check size={12} role="img" aria-label="Done" className="mt-0.5 shrink-0 text-status-published" />;
  if (outcome === 'failed') return <X size={12} role="img" aria-label="Failed" className="mt-0.5 shrink-0 text-destructive" />;
  if (outcome === 'awaiting_approval') return <Clock size={12} role="img" aria-label="Needs your approval" className={`mt-0.5 shrink-0 ${WARNING_CLASS}`} />;
  if (outcome === 'declined') return <X size={12} role="img" aria-label="Declined" className={`mt-0.5 shrink-0 ${WARNING_CLASS}`} />;
  return <AlertTriangle size={12} role="img" aria-label="Refused" className={`mt-0.5 shrink-0 ${WARNING_CLASS}`} />;
}

const AgentActivityPanel = observer(function AgentActivityPanel() {
  const { editorUI } = useStore();
  const presence = editorUI.livePresence as LivePresenceStore | undefined;
  const project = editorUI.currentProject;
  const listId = React.useId();
  if (!project || !presence || (!presence.everActive && presence.feed.length === 0)) return null;
  const projectPages = Array.from(project.pages.values()) as PageModelType[];
  // The pages of component definitions too: an agent can edit the one open on the canvas.
  const pages = presencePagesOf(project as unknown as PresenceProject) as unknown as PageModelType[];
  // Remembered, so a page an agent deletes can still be named in its line.
  rememberPageTitles(project, projectPages);
  const titleOf = (id: string): string | undefined => pages.find((p) => p.id === id)?.metadata.title || rememberedPageTitle(project, id);
  const lead = presence.leadAgentId ? presence.agents.get(presence.leadAgentId) : undefined;
  const open = presence.panelOpen;

  const reveal = (line: LiveFeedLine) => {
    const target = lineTarget(pages, line);
    if (!target) return;
    if (editorUI.currentPage?.id !== target.page.id) {
      if (projectPages.includes(target.page)) {
        editorUI.setCurrentPage(target.page);
      } else {
        // A component definition opens the way the editor opens it, with its way back.
        const definition = Array.from(project.components.values()).find((d) => d.page === target.page);
        if (!definition) return;
        editorUI.enterComponent(definition.id);
      }
    }
    if (target.nodes.length === 0) return;
    const current = editorUI.currentPage as PageModelType | undefined;
    // Tree nodes need their frame as viewport context, or the canvas shows no outline and no handles.
    const breakpointId = current ? breakpointFor(current, editorUI.currentViewportNode?.breakpointId) : undefined;
    editorUI.setSelection(target.nodes, breakpointId);
    // Bring the first one into view on the next frame, once the page is drawn.
    requestAnimationFrame(() => {
      const element = document.querySelector(`[data-camera-transform] [data-inner-component-id="${CSS.escape(target.nodes[0].id)}"]`);
      const ground = document.querySelector<HTMLElement>('[data-ground]');
      if (!element || !ground) return;
      const { dx, dy } = revealOffset(element.getBoundingClientRect(), ground.getBoundingClientRect(), 48);
      const camera = editorUI.canvasCamera;
      if (!camera || (dx === 0 && dy === 0)) return;
      const at = camera.read();
      camera.write({ zoom: at.zoom, panX: at.panX + dx, panY: at.panY + dy });
    });
  };

  return (
    <section data-agent-activity-panel="" aria-label="Agent activity" className="flex min-h-9 shrink flex-col overflow-hidden border-t border-border">
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => presence.setPanelOpen(!open)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex flex-1 min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          {presence.anyActive && <span aria-hidden="true" className="block size-1.5 shrink-0 rounded-full bg-agent-presence forced-colors:bg-[CanvasText]" />}
          <span className="truncate">Agent activity</span>
        </button>
        <button
          type="button"
          onClick={() => {
            // Its pressed state is spoken: the announcer must not say it again.
            noteFollowToggledByPerson(presence);
            presence.setFollow(!presence.follow);
          }}
          aria-pressed={presence.follow}
          title={followTitle(presence.follow, lead?.label)}
          className={`inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            presence.follow ? 'bg-agent-presence/15 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          <Crosshair size={12} aria-hidden="true" />
          Follow
        </button>
      </div>
      {open && (
        <ol id={listId} className="min-h-0 max-h-[min(14rem,30vh)] overflow-y-auto px-2 pb-2" aria-label="Agent activity, newest first">
          {presence.feed.length === 0 && (
            <li className="px-1 py-1 text-xs text-muted-foreground">No agent activity yet. Each step an agent takes on this site shows here.</li>
          )}
          {presence.feed.map((line) => {
            const page = line.pageId ? pages.find((p) => p.id === line.pageId) : undefined;
            const text = feedLineText(line, page?.metadata.title, (line.deletedPageIds ?? []).map(titleOf));
            const time = feedLineTime(line.at);
            const meta = `${time ? `${time} · ` : ''}${line.label}`;
            const clickable = !!lineTarget(pages, line);
            const body = (
              <>
                <StatusMark outcome={line.outcome} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground" title={text}>
                    {text}
                  </span>
                  <span className="block truncate text-[11px] leading-tight text-muted-foreground" title={meta}>
                    {meta}
                  </span>
                </span>
              </>
            );
            return (
              <li key={line.id} data-agent-feed-line={line.id}>
                {clickable ? (
                  <button
                    type="button"
                    onClick={() => reveal(line)}
                    title="Select on the canvas"
                    className="flex w-full items-start gap-1.5 rounded px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-1.5 px-1 py-1">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
});

AgentActivityPanel.displayName = 'AgentActivityPanel';
export default AgentActivityPanel;
