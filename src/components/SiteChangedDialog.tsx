'use client';
// src/components/SiteChangedDialog.tsx
//
// The version lock's question (src/stores/openProject.ts): the project was
// written somewhere else (another tab, a person, an agent) while this tab has
// unsaved changes. It opens as soon as the site's live stream announces the
// other write (src/lib/projects/liveSync.ts), or when a Save or Publish came
// back 409 `site_changed`. Nothing was written. Instead of overwriting the
// other work unseen, the person picks:
//   - Load the newer version: take the newer copy in place, discarding this
//     tab's unsaved changes, as one undo step (so even this can be undone and
//     saved over); the page reloads only when the copy cannot be fetched;
//   - Keep mine: save (or publish) this tab's copy over the other one, on
//     purpose, naming the version the server reported. Should the project move
//     again meanwhile, the server refuses again and this dialog returns;
//   - Save mine as a new project: keep both, this tab's pages and components
//     become a project of their own (SaveAsNewProjectDialog);
//   - Keep editing: close, nothing happens; autosave stays paused and the top
//     bar's "Changed elsewhere" (or Cmd+S) asks again.
// Shared by SaveStatus (autosave) and PublishButton, which own the request itself.

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface SiteChangedDialogProps {
  open: boolean;
  /** What the refused request was: names the "keep mine" action. */
  action: 'save' | 'publish';
  /** True while the "keep mine" request runs. */
  busy: boolean;
  /** Close without doing anything (Keep editing, Escape, the overlay). */
  onKeepEditing: () => void;
  /** Take the newer version, discarding this tab's unsaved changes. */
  onLoadNewer: () => void;
  /** Write this tab's copy over the other one. */
  onKeepMine: () => void;
  /** Save this tab's copy as a new project instead. */
  onSaveAsNew: () => void;
}

export default function SiteChangedDialog({
  open,
  action,
  busy,
  onKeepEditing,
  onLoadNewer,
  onKeepMine,
  onSaveAsNew,
}: SiteChangedDialogProps) {
  const keepMineLabel = action === 'publish' ? 'Publish mine anyway' : 'Save mine over it';
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onKeepEditing();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>This project was changed somewhere else</DialogTitle>
          <DialogDescription>
            Someone (another tab, another person or an agent) saved this project while this tab
            has unsaved changes. Nothing was {action === 'publish' ? 'published' : 'saved'}. {keepMineLabel}{' '}
            replaces those changes with this tab&apos;s version; loading the newer version discards
            the unsaved changes in this tab.
          </DialogDescription>
        </DialogHeader>
        <p role="status" aria-live="polite" className="sr-only">
          {busy ? (action === 'publish' ? 'Publishing…' : 'Saving…') : ''}
        </p>
        <DialogFooter className="flex-wrap">
          <Button type="button" variant="outline" size="sm" aria-disabled={busy || undefined} onClick={() => !busy && onKeepEditing()}>
            Keep editing
          </Button>
          <Button type="button" variant="outline" size="sm" aria-disabled={busy || undefined} onClick={() => !busy && onSaveAsNew()}>
            Save mine as a new project
          </Button>
          <Button type="button" variant="outline" size="sm" aria-disabled={busy || undefined} onClick={() => !busy && onKeepMine()}>
            {busy ? (action === 'publish' ? 'Publishing…' : 'Saving…') : keepMineLabel}
          </Button>
          <Button type="button" size="sm" aria-disabled={busy || undefined} onClick={() => !busy && onLoadNewer()}>
            Load the newer version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
