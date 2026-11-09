// src/components/live/AgentDeletedPageWatcher.tsx
//
// When an agent's write deletes the page this editor has open, the adoption of
// that write moves the canvas to another page (src/stores/openProject.ts,
// adoptServerCopy). This says why, above the canvas: "Claude deleted the page
// ‘About’." (editorUI.editorNotice, kind `pageDeleted`, drawn by
// src/components/EditorNotice.tsx with its polite live region), with Undo, which
// runs the ordinary history undo of that agent's step: the adoption recorded it
// as one remote entry (HistoryStore.applyRemote), so undoing it brings the page
// back, and autosave then saves that like any other undo. Undo is offered only
// while that entry is still the last one applied.
//
// It tells the agent's delete from any other way the open page can go: the page
// left in a recorded remote step, and an agent's feed line names it among the
// pages it deleted (the line and the adoption can come in either order). A
// person deleting a page in this tab, or another person's save, shows nothing
// here. Renders nothing.
'use client';

import React from 'react';
import { reaction } from 'mobx';
import { useStore } from '@/hooks/useStore';
import { getHistoryStore } from '@/stores/RootStore';
import { deletedOpenPageNotice } from '@/lib/live/activityText';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import type { LiveFeedLine } from '@/lib/projects/liveEvents';

/** How long a deleted open page waits for the agent's feed line that names it. */
export const DELETED_PAGE_LINE_WAIT_MS = 30_000;

interface Gone {
  pageId: string;
  title: string | undefined;
  historyEntryId: string;
  at: number;
}

/** The agent line that deleted this page, if the feed holds one. */
function deletingLine(feed: readonly LiveFeedLine[], pageId: string): LiveFeedLine | undefined {
  return feed.find((l) => l.actorKind === 'key' && l.outcome === 'ok' && l.deletedPageIds?.includes(pageId));
}

export default function AgentDeletedPageWatcher() {
  const { editorUI } = useStore();

  React.useEffect(() => {
    const presence = editorUI.livePresence as LivePresenceStore | undefined;
    if (!presence) return;
    let gone: Gone | undefined;

    const show = (line: LiveFeedLine, page: Gone) => {
      gone = undefined;
      editorUI.setEditorNotice({
        kind: 'pageDeleted',
        message: deletedOpenPageNotice(line.label, page.title),
        pageId: page.pageId,
        historyEntryId: page.historyEntryId,
      });
    };

    const disposers = [
      // The open page, and its title while it is there.
      reaction(
        () => {
          const page = editorUI.currentPage;
          return { projectId: editorUI.currentProject?.id, pageId: page?.id, title: page?.metadata.title as string | undefined };
        },
        (now, before) => {
          if (!before.pageId || now.pageId === before.pageId || now.projectId !== before.projectId) return;
          const project = editorUI.currentProject;
          if (!project || project.getPage(before.pageId)) return;
          // It left in a step recorded from outside this tab (an adoption), the last one applied.
          const history = getHistoryStore();
          const entry = history && history.undoIdx > 0 ? history.history[history.undoIdx - 1] : undefined;
          if (!entry?.remote) return;
          const page: Gone = { pageId: before.pageId, title: before.title || undefined, historyEntryId: entry.id, at: Date.now() };
          const line = deletingLine(presence.feed, page.pageId);
          if (line) show(line, page);
          else gone = page;
        },
      ),
      // The agent's line may come after the adoption.
      reaction(
        () => presence.feed,
        (feed) => {
          if (!gone) return;
          if (Date.now() - gone.at > DELETED_PAGE_LINE_WAIT_MS) {
            gone = undefined;
            return;
          }
          const line = deletingLine(feed, gone.pageId);
          if (line) show(line, gone);
        },
      ),
    ];
    return () => disposers.forEach((d) => d());
  }, [editorUI]);

  return null;
}
