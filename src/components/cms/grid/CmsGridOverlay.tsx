'use client';

// src/components/cms/grid/CmsGridOverlay.tsx
//
// Full-screen overlay shell for the CMS editing grid. The Content tab in the
// left sidebar stays a compact collection list; opening a collection mounts this
// overlay over the canvas so the Notion-style grid gets full width while the
// editor chrome underneath is preserved. Escape or the Close button returns to
// the canvas.
//
// It renders through a portal to document.body: the panel lives deep inside the
// left sidebar's DOM (which sits in its own stacking context), so a `fixed`
// overlay there would still paint BELOW the right properties sidebar. Portaling
// to the body escapes every ancestor stacking context, so a single high z-index
// reliably covers the whole editor chrome.

import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import CmsGrid from './CmsGrid';
import { collectionIcon } from '../collectionIcon';

export interface CmsGridOverlayProps {
  tableId: string;
  collectionName: string;
  onClose: () => void;
}

export default function CmsGridOverlay({ tableId, collectionName, onClose }: CmsGridOverlayProps) {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Only close on a bare Escape, and not while a cell editor is open (the
      // grid handles Escape-to-cancel-edit itself; we don't want to yank the
      // whole overlay out from under an in-progress edit).
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!mounted) return null;

  const Icon = collectionIcon(tableId);

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit collection ${collectionName}`}
      data-testid="cms-grid-overlay"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Content
          </span>
          <span className="text-border">/</span>
          <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <span className="flex size-5 items-center justify-center rounded-[6px] bg-brand/12 text-brand">
              <Icon className="size-3.5" />
            </span>
            {collectionName}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close content editor"
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1">
        <CmsGrid tableId={tableId} />
      </div>
    </div>,
    document.body,
  );
}
