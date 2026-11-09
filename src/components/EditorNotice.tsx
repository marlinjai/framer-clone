'use client';
// src/components/EditorNotice.tsx
//
// One dismissable message above the canvas (editorUI.editorNotice), set when a
// project opens: the project was changed elsewhere while this tab has unsaved
// work (a Save here would overwrite it), or the page asked for in the address
// does not exist. Also when an agent's new page is ready while the person works
// elsewhere (src/lib/projects/liveSync.ts): Open it shows that page. And when an
// agent deleted the page that was open (src/components/live/AgentDeletedPageWatcher.tsx):
// Undo brings it back while that step is the last one applied and did nothing else. The live region is
// always present, so the message is announced when it appears.
//
// It is also the badge of a state preview (editorUI.previewState): the canvas shows a
// state at another value than its first, so a layer hidden by it can be edited. Closing
// that notice ends the preview, so nothing on the canvas differs from the page unnamed.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { reloadDiscarding } from '@/lib/projects/autosave';
import { getHistoryStore } from '@/stores/RootStore';

/**
 * Whether the history entry only removed this page: each of its inverse patches puts back that
 * page, or the project's updatedAt stamp. An adopted step can hold more (an agent's batch that
 * also edited other pages, or several writers' versions fetched together); undoing it would take
 * all of that back too, so the notice then offers no Undo.
 */
export function onlyRemovedPage(inversePatches: ReadonlyArray<{ path: string }>, pageId: string): boolean {
  const escaped = pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allowed = new RegExp(`^/projects/[^/]+/(pages/${escaped}(/|$)|metadata/updatedAt$)`);
  return inversePatches.length > 0 && inversePatches.every((p) => allowed.test(p.path));
}

/**
 * Whether Undo can bring back the page an agent deleted (src/components/live/AgentDeletedPageWatcher.tsx):
 * its step is still the last one applied, and that step did nothing else.
 */
export function canUndoAgentDelete(historyEntryId: string | undefined, pageId: string | undefined): boolean {
  const history = getHistoryStore();
  if (!history || !historyEntryId || !pageId || history.undoIdx === 0) return false;
  const entry = history.history[history.undoIdx - 1];
  return entry?.id === historyEntryId && onlyRemovedPage(entry.inversePatches, pageId);
}

/** After a notice's button leaves with the notice: the focus goes to the open page's row in the Pages panel, or else to the canvas. */
function focusOpenPage(): void {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>('button[aria-current="page"]');
    if (row) {
      row.focus();
      return;
    }
    const canvas = document.querySelector<HTMLElement>('[data-ground]');
    if (!canvas) return;
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
    canvas.focus({ preventScroll: true });
  });
}

const EditorNotice = observer(() => {
  const { editorUI } = useStore();
  const notice = editorUI.editorNotice;
  return (
    <div
      role="status"
      aria-live="polite"
      data-editor-ui="true"
      // Placed by EditorApp's notice stack under the top bar.
      className={notice ? 'pointer-events-auto flex max-w-[640px] items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow' : 'sr-only'}
    >
      {notice ? (
        <>
          <span>{notice.message}</span>
          {notice.kind === 'changedElsewhere' ? (
            <button
              type="button"
              // On purpose: this tab's unsaved work goes, so the reload must not warn.
              onClick={() => reloadDiscarding(editorUI.currentProject?.id)}
              className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100"
            >
              Load the newer version
            </button>
          ) : null}
          {notice.kind === 'newPage' && notice.pageId ? (
            <button
              type="button"
              // The visible words first (Label in Name), then which page.
              aria-label={`Open it: the page ${editorUI.currentProject?.getPage(notice.pageId)?.metadata.title ?? ''}`.trim()}
              onClick={() => {
                const page = editorUI.currentProject?.getPage(notice.pageId!);
                if (page) editorUI.setCurrentPage(page);
                editorUI.setEditorNotice(undefined);
                // The button goes with the notice: the focus moves to the page's row in the Pages panel, or else to the canvas.
                focusOpenPage();
              }}
              className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100"
            >
              Open it
            </button>
          ) : null}
          {notice.kind === 'pageDeleted' && canUndoAgentDelete(notice.historyEntryId, notice.pageId) ? (
            <button
              type="button"
              // The visible word first (Label in Name), then what it does.
              aria-label="Undo: bring the page back"
              onClick={() => {
                if (!canUndoAgentDelete(notice.historyEntryId, notice.pageId)) return;
                // The page comes back; the watcher then opens it and clears this notice, as after any undo.
                getHistoryStore()?.undo();
                focusOpenPage();
              }}
              className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100"
            >
              Undo
            </button>
          ) : null}
          {notice.preview ? <span>{notice.preview}</span> : null}
          {notice.kind === 'previewState' || notice.preview ? (
            <button
              type="button"
              onClick={() => editorUI.clearPreviewState()}
              className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100"
            >
              Show first values
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              // Closing a preview's badge ends the preview, wherever the badge sits.
              if (notice.kind === 'previewState' || notice.preview) editorUI.clearPreviewState();
              if (notice.kind !== 'previewState') editorUI.setEditorNotice(undefined);
            }}
            aria-label="Dismiss notice"
            className="shrink-0 rounded px-1 hover:bg-amber-100"
          >
            ×
          </button>
        </>
      ) : null}
    </div>
  );
});

EditorNotice.displayName = 'EditorNotice';
export default EditorNotice;
