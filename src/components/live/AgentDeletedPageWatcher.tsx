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
// while that entry is still the last one applied and did nothing but remove the
// page (an adopted step can hold other edits too, which an undo would revert).
// However the page comes back (the button, Cmd+Z, the history panel), it opens
// again and the notice goes, so it never states what is no longer true.
//
// It tells the agent's delete from any other way the open page can go: the page
// left in a recorded remote step, and an agent's feed line names it among the
// pages it deleted (the line and the adoption can come in either order, within
// DELETED_PAGE_LINE_WAIT_MS of each other, judged on the server's own stamps (the line's time
// against the adopted project's updatedAt) so a browser clock that runs fast or slow changes
// nothing; a line explains one deletion, and a redo of that same step brings its notice back).
// A person deleting a page in this tab, or another person's save, shows nothing
// here. Renders nothing.
'use client';

import React from 'react';
import { reaction } from 'mobx';
import { useStore } from '@/hooks/useStore';
import { getHistoryStore } from '@/stores/RootStore';
import { deletedOpenPageNotice } from '@/lib/live/activityText';
import type { LivePresenceStore } from '@/lib/live/presenceStore';
import type { LiveFeedLine } from '@/lib/projects/liveEvents';
import type { EditorNoticeState } from '@/stores/EditorUIStore';

/** How long a deleted open page waits for the agent's feed line that names it. */
export const DELETED_PAGE_LINE_WAIT_MS = 30_000;

interface Gone {
  pageId: string;
  title: string | undefined;
  historyEntryId: string;
  /** This tab's clock: when the page left, for how long its line is waited for. */
  at: number;
  /** The server's clock: the adopted project's updatedAt, what the line's time is compared with. */
  serverAt: number;
}

/** A line's time in milliseconds, or -Infinity when unreadable. */
function atOf(line: Pick<LiveFeedLine, 'at'>): number {
  const t = Date.parse(line.at);
  return Number.isFinite(t) ? t : -Infinity;
}

/** The agent line that deleted this page, close to the server's stamp of the adopted write, and explains no other deletion yet, if the feed holds one. */
function deletingLine(feed: readonly LiveFeedLine[], page: Gone, used: ReadonlySet<string>): LiveFeedLine | undefined {
  return feed.find(
    (l) =>
      l.actorKind === 'key' &&
      l.outcome === 'ok' &&
      !used.has(l.id) &&
      l.deletedPageIds?.includes(page.pageId) &&
      Math.abs(page.serverAt - atOf(l)) <= DELETED_PAGE_LINE_WAIT_MS,
  );
}

/** The notice that was showing while this one is up, kept so a preview's badge and reset action survive it. */
function previewOf(notice: EditorNoticeState | undefined): string | undefined {
  return notice?.kind === 'previewState' ? notice.message : notice?.preview;
}

export default function AgentDeletedPageWatcher() {
  const { editorUI } = useStore();

  React.useEffect(() => {
    const presence = editorUI.livePresence as LivePresenceStore | undefined;
    if (!presence) return;
    let gone: Gone | undefined;
    // The lines that explained a deletion already: one line, one deletion.
    const used = new Set<string>();
    // Which agent explained which history entry: a redo of that step deletes the page again, and says so again.
    const explained = new Map<string, { pageId: string; label: string }>();

    const show = (label: string, page: Gone) => {
      gone = undefined;
      explained.set(page.historyEntryId, { pageId: page.pageId, label });
      const preview = previewOf(editorUI.editorNotice);
      editorUI.setEditorNotice({
        kind: 'pageDeleted',
        message: deletedOpenPageNotice(label, page.title),
        pageId: page.pageId,
        historyEntryId: page.historyEntryId,
        ...(preview ? { preview } : {}),
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
          const stamp = project.metadata.updatedAt;
          const page: Gone = {
            pageId: before.pageId,
            title: before.title || undefined,
            historyEntryId: entry.id,
            at: Date.now(),
            serverAt: stamp instanceof Date ? stamp.getTime() : Number.NaN,
          };
          const again = explained.get(entry.id);
          if (again && again.pageId === page.pageId) return show(again.label, page);
          const line = deletingLine(presence.feed, page, used);
          if (line) {
            used.add(line.id);
            show(line.label, page);
          } else gone = page;
        },
      ),
      // The agent's line may come after the adoption.
      reaction(
        () => presence.feed,
        (feed) => {
          if (!gone) return;
          // Past the wait, or the page came back before its line did: nothing left to explain.
          if (Date.now() - gone.at > DELETED_PAGE_LINE_WAIT_MS || editorUI.currentProject?.getPage(gone.pageId)) {
            gone = undefined;
            return;
          }
          const line = deletingLine(feed, gone, used);
          if (line) {
            used.add(line.id);
            show(line.label, gone);
          }
        },
      ),
      // The page came back, by any undo: it opens again and the notice goes.
      reaction(
        () => {
          const notice = editorUI.editorNotice;
          if (notice?.kind !== 'pageDeleted' || !notice.pageId) return undefined;
          return editorUI.currentProject?.getPage(notice.pageId) ? notice.pageId : undefined;
        },
        (pageId) => {
          if (!pageId) return;
          const page = editorUI.currentProject?.getPage(pageId);
          if (page) editorUI.setCurrentPage(page);
          const preview = previewOf(editorUI.editorNotice);
          editorUI.setEditorNotice(preview ? { kind: 'previewState', message: preview } : undefined);
        },
      ),
    ];
    return () => disposers.forEach((d) => d());
  }, [editorUI]);

  return null;
}
