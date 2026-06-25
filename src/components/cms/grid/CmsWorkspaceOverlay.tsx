'use client';

// src/components/cms/grid/CmsWorkspaceOverlay.tsx
//
// Full-screen workspace overlay for the CMS: a [ collections rail | items grid ]
// surface where the builder can see every collection at once and switch between
// them without closing.
//
// Portals to document.body (via createPortal) so the overlay escapes the left
// sidebar's stacking context and covers the full editor chrome at z-[1000].
// Escape closes the overlay unless a cell editor (input/textarea/contentEditable)
// is focused. The `.light` class is pinned on the root div so the data-table
// grid always renders in its light theme regardless of the surrounding editor
// theme (preserves the dark-theme fix from commit 079adb5).
//
// Phase 2 (right content-agent column) is a reserved slot: the layout is
// currently `[rail | grid]`; adding the agent column is a CSS-grid column
// addition with no structural refactor.

import React from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Upload,
  Database,
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import type { Collection } from '@/lib/bindings/dataSource/types';
import { CMS_WORKSPACE_ID } from '@/lib/cms/constants';
import CollectionRail from '../CollectionRail';
import CmsGrid from './CmsGrid';
import ContentAgentPanel from '../agent/ContentAgentPanel';
import { resolveCollectionIcon } from '../collectionIcon';

export interface CmsWorkspaceOverlayProps {
  collections: Collection[];
  activeId: string;
  busy: boolean;
  onSetActive: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onUpdate: (id: string, updates: { name?: string; icon?: string }) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export default function CmsWorkspaceOverlay({
  collections,
  activeId,
  busy,
  onSetActive,
  onCreate,
  onRename,
  onUpdate,
  onDelete,
  onClose,
}: CmsWorkspaceOverlayProps) {
  const [mounted, setMounted] = React.useState(false);
  // The agent column is visible by default; collapse is local-only (not persisted).
  const [agentOpen, setAgentOpen] = React.useState(true);
  // Bumped on agent:done so the grid re-mounts and re-fetches the new rows.
  const [gridNonce, setGridNonce] = React.useState(0);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const onRunComplete = React.useCallback(() => {
    setGridNonce((n) => n + 1);
  }, []);

  // Escape closes the overlay unless a cell editor (input/textarea/contentEditable)
  // is focused. The grid handles Escape-to-cancel-edit internally first, so this
  // guard prevents the overlay from yanking out from under an in-progress edit.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!mounted) return null;

  const activeCollection = collections.find((c) => c.id === activeId);
  const ActiveIcon = activeCollection
    ? resolveCollectionIcon(activeCollection.icon, activeCollection.id)
    : Database;

  return createPortal(
    <div
      className="light fixed inset-0 z-[1000] flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="CMS workspace"
      data-testid="cms-workspace-overlay"
    >
      {/* Top bar: brand cluster + Import CSV (disabled) + Close */}
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-3.5">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold">
          <span className="flex size-[22px] items-center justify-center rounded-[6px] bg-brand/12 text-brand">
            <Database className="size-[13px]" />
          </span>
          <span className="text-foreground">Content</span>
          <span className="text-muted-foreground">/</span>
          {activeCollection ? (
            <span className="flex items-center gap-1 font-medium text-muted-foreground">
              <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-brand/12 text-brand">
                <ActiveIcon className="size-[11px]" />
              </span>
              {activeCollection.name}
              <ChevronDown className="size-[13px] text-muted-foreground/60" />
            </span>
          ) : null}
        </div>

        <div className="flex-1" />

        <button
          type="button"
          disabled
          aria-label="Import CSV (coming soon)"
          data-testid="workspace-import-csv"
          title="Coming soon"
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-semibold text-muted-foreground opacity-50"
        >
          <Upload className="size-[15px]" />
          Import CSV
        </button>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close CMS workspace"
          data-testid="workspace-close"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-[15px]" />
          Close
        </button>
      </header>

      {/* Body: [rail | grid] -- phase 2 adds a third agent column here */}
      <div className="flex min-h-0 flex-1">
        <CollectionRail
          collections={collections}
          activeId={activeId}
          busy={busy}
          onOpen={onSetActive}
          onCreate={onCreate}
          onRename={onRename}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />

        {/* Items grid: center pane */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Grid sub-header: name + item count + view segment (Board/Calendar disabled) + Filter + New item */}
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-3.5">
            {activeCollection ? (
              <>
                <span className="text-[14px] font-semibold text-foreground">
                  {activeCollection.name}
                </span>
                {typeof activeCollection.itemCount === 'number' && (
                  <span
                    className="font-mono text-[12px] text-muted-foreground"
                    data-testid="workspace-item-count"
                  >
                    {activeCollection.itemCount}{' '}
                    {activeCollection.itemCount === 1 ? 'item' : 'items'}
                  </span>
                )}
              </>
            ) : null}

            <div className="flex-1" />

            {/* View segment: Table active, Board + Calendar disabled */}
            <div
              className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
              role="group"
              aria-label="View"
            >
              <button
                type="button"
                className="rounded-[6px] bg-background px-2.5 py-1 text-[12px] font-medium text-foreground shadow-xs"
                aria-pressed="true"
              >
                Table
              </button>
              <button
                type="button"
                disabled
                title="Coming soon"
                className="cursor-not-allowed rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-muted-foreground opacity-50"
                aria-pressed="false"
                data-testid="workspace-board-disabled"
              >
                Board
              </button>
              <button
                type="button"
                disabled
                title="Coming soon"
                className="cursor-not-allowed rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-muted-foreground opacity-50"
                aria-pressed="false"
                data-testid="workspace-calendar-disabled"
              >
                Calendar
              </button>
            </div>

            {/* Agent column collapse toggle (local-only) */}
            <button
              type="button"
              onClick={() => setAgentOpen((v) => !v)}
              aria-label={agentOpen ? 'Collapse content agent' : 'Expand content agent'}
              aria-pressed={agentOpen}
              data-testid="workspace-agent-toggle"
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {agentOpen ? (
                <PanelRightClose className="size-[16px]" />
              ) : (
                <PanelRightOpen className="size-[16px]" />
              )}
            </button>
          </div>

          {/* The data-table-react grid: key bumps on collection switch AND on
              agent:done (gridNonce) so it re-mounts and re-fetches. */}
          <div className="min-h-0 flex-1">
            <CmsGrid key={`${activeId}:${gridNonce}`} tableId={activeId} />
          </div>
        </div>

        {/* Right column: the natural-language content agent (collapsible). */}
        {agentOpen ? (
          <ContentAgentPanel
            key={activeId}
            collectionId={activeId}
            workspaceId={CMS_WORKSPACE_ID}
            collectionName={activeCollection?.name ?? 'collection'}
            onRunComplete={onRunComplete}
          />
        ) : (
          <div className="flex w-10 shrink-0 flex-col items-center border-l border-border bg-muted/30 py-2">
            <button
              type="button"
              onClick={() => setAgentOpen(true)}
              aria-label="Expand content agent"
              data-testid="workspace-agent-expand"
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PanelRightOpen className="size-[16px]" />
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
