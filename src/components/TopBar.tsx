// src/components/TopBar.tsx
// Editor top bar: project title (left), reserved space (middle, intended for
// future tool-category tabs like Insert / Layout / Text), undo / redo +
// history dropdown (right). Page navigation lives in the left sidebar's
// Pages pane, not here — see LeftSidebar.tsx.
//
// Marked data-editor-ui so the drag resolver treats hits here as chrome
// (cancels drops silently).
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import {
  Undo2,
  Redo2,
  History as HistoryIcon,
  RotateCcw,
  Play,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/hooks/useStore';
import { getHistoryStore } from '@/stores/RootStore';
import PublishButton from '@/components/PublishButton';

function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// --- HistoryMenu -----------------------------------------------------------
// Chevron dropdown beside Undo/Redo. Shows recent entries newest-first, each
// clickable to jumpTo(). Closes on outside click / Escape. Kept local so we
// don't pull in a popover library for one use-site.
const HistoryMenu = observer(() => {
  const history = getHistoryStore();
  const [open, setOpen] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!history) return null;

  const entries = history.history.slice().reverse();
  const originalLen = history.history.length;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="History"
        className={`flex items-center gap-1.5 px-2 h-8 rounded text-sm text-foreground hover:bg-accent ${open ? 'bg-muted' : ''}`}
      >
        <HistoryIcon size={16} />
        <span className="text-xs text-muted-foreground">
          {history.undoIdx}/{originalLen}
        </span>
      </button>
      {open && (
        <div
          data-editor-ui="true"
          className="absolute right-0 top-full mt-1 w-72 bg-background border border-border rounded-md shadow-lg overflow-hidden z-[100]"
        >
          <div className="max-h-80 overflow-y-auto p-1">
            {entries.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No actions yet.
              </div>
            ) : (
              entries.map((entry, displayIdx) => {
                const originalIdx = originalLen - 1 - displayIdx;
                const isApplied = history.undoIdx > originalIdx;
                const isCurrent = history.undoIdx === originalIdx + 1;
                return (
                  <button
                    key={entry.id}
                    onClick={() => history.jumpTo(originalIdx + 1)}
                    className={`w-full flex items-start gap-2 text-left px-2 py-1.5 rounded text-xs transition-colors ${
                      isCurrent
                        ? 'bg-brand/10 border-l-2 border-brand'
                        : isApplied
                          ? 'text-foreground hover:bg-accent'
                          : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <RotateCcw size={12} className="mt-0.5 shrink-0 opacity-60" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{history.labelFor(entry)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {relativeTime(entry.timestamp, now)}
                        {entry.patches.length > 1 && ` · ${entry.patches.length} patches`}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
            <button
              onClick={() => history.jumpTo(0)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs italic ${
                history.undoIdx === 0
                  ? 'bg-brand/10 border-l-2 border-brand text-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              <RotateCcw size={12} className="opacity-60" />
              Initial state
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
HistoryMenu.displayName = 'HistoryMenu';

// --- TopBar ----------------------------------------------------------------
const TopBar = observer(() => {
  const rootStore = useStore();
  const { editorUI } = rootStore;
  const project = editorUI.currentProject;
  const currentPage = editorUI.currentPage;
  const history = getHistoryStore();
  const router = useRouter();

  return (
    <header
      data-editor-ui="true"
      className="fixed top-0 left-0 right-0 h-16 bg-background border-b border-border flex items-center z-90"
    >
      {/* Left: project title + current page (Framer-style breadcrumb, since
          the page tabs moved to the sidebar). */}
      <div className="flex items-center gap-2 px-6 min-w-[200px] shrink-0">
        <div className="text-sm font-semibold text-foreground truncate max-w-[180px]">
          {project?.metadata.title ?? 'Untitled Project'}
        </div>
        {currentPage && (
          <>
            <span className="text-muted-foreground">/</span>
            <div
              className="text-sm text-muted-foreground truncate max-w-[160px]"
              title={currentPage.metadata.title}
            >
              {currentPage.metadata.title}
            </div>
          </>
        )}
      </div>

      {/* Middle: reserved for tool-category tabs (Insert / Layout / Text /
          Vector / CMS) in a future iteration. Left empty rather than with
          placeholder boxes so the bar reads as intentional, not unfinished. */}
      <div className="flex-1" />

      {/* Publish: the primary rightward action. Serializes the live project
          and pushes it live via the admin-guarded publish endpoint. */}
      <PublishButton />

      {/* Preview entry — sits just before the undo/redo cluster so it's
          visually grouped with the other rightward actions. */}
      <button
        type="button"
        onClick={() => router.push('/preview')}
        title="Preview"
        className="flex items-center justify-center w-8 h-8 rounded text-foreground hover:bg-accent mr-2"
      >
        <Play size={16} />
      </button>

      {/* Right: undo / redo / history */}
      <div className="flex items-center gap-1 px-3 border-l border-border shrink-0 h-full">
        <button
          type="button"
          onClick={() => history?.undo()}
          disabled={!history?.canUndo}
          title="Undo (Cmd+Z)"
          className="flex items-center justify-center w-8 h-8 rounded text-foreground hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          onClick={() => history?.redo()}
          disabled={!history?.canRedo}
          title="Redo (Cmd+Shift+Z)"
          className="flex items-center justify-center w-8 h-8 rounded text-foreground hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Redo2 size={16} />
        </button>
        <HistoryMenu />
      </div>
    </header>
  );
});

TopBar.displayName = 'TopBar';
export default TopBar;
