'use client';

// src/components/branches/UndoMerge.tsx
//
// "Undo this merge" on a merged branch's old address (docs/plans/2026-11-10-site-branches.md, section 3,
// "Afterwards", slice S7). The dialog says what the undo does before it does it: the site goes back to what it
// was before the merge, and everything the site holds now, the merged work and any change made since, moves to
// a new branch. Nothing is published either way. On success the editor opens the new branch.
// The switcher's "Recently merged" offers the same undo with the same dialog (UndoMergeDialog).

import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BranchApiError, branchClient } from '@/lib/sites/branchClient';

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });

/** What a refusal means for the person, in the page's own words where the server's are an editor tab's. */
export function undoErrorText(err: unknown): string {
  if (err instanceof BranchApiError) {
    if (err.status === 403) return 'You may not merge branches into this site, so you cannot undo a merge either. Ask someone who can.';
    return err.message;
  }
  return 'Undoing the merge failed. Nothing was changed; try again.';
}

/**
 * The dialog and the request of "Undo this merge", for every place that offers it: the merged branch's old
 * address (below) and the switcher's "Recently merged" (BranchSwitcher.tsx). The caller holds whether it is
 * open, and hears the two ways it ends: the new branch that took the work, or the server's word that this
 * merge can no longer be undone.
 */
export function UndoMergeDialog({
  open,
  onOpenChange,
  mainSiteId,
  branchId,
  branchName,
  mainName,
  onUndone,
  onEnded,
  before,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mainSiteId: string;
  branchId: string;
  branchName: string;
  mainName: string;
  /** The merge was undone (now, or earlier in another tab): the new open branch that holds the merged work. */
  onUndone: (newBranchId: string) => void;
  /** The server said this merge can no longer be undone, in its words. The dialog closes. */
  onEnded: (reason: string) => void;
  /** Runs before the request (an open editor saves its work): a text is why the undo cannot start yet. */
  before?: () => Promise<string | null>;
  /** Where the focus goes when the dialog closes. */
  returnFocus?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      const wait = before ? await before() : null;
      if (wait) {
        setBusy(false);
        setError(wait);
        return;
      }
      const outcome = await branchClient.undoMerge(mainSiteId, branchId);
      onUndone(outcome.branch.branchId);
    } catch (err) {
      setBusy(false);
      if (err instanceof BranchApiError && err.code === 'merge_undo_unavailable') {
        onEnded(err.message);
        onOpenChange(false);
        return;
      }
      setError(undoErrorText(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return;
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Undo the merge of “{branchName}”?</DialogTitle>
          <DialogDescription>
            {mainName} goes back to what it was just before this merge. Everything it holds now, the merged changes and
            anything changed on the site since, moves to a new branch, so nothing is lost and you can merge it again
            later. Nothing is published or unpublished: visitors keep seeing the published site.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              setError(null);
            }}
            disabled={busy}
          >
            Keep the merge
          </Button>
          <Button type="button" onClick={undo} disabled={busy}>
            {busy ? 'Undoing…' : 'Undo the merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function UndoMerge({
  mainSiteId,
  branchId,
  branchName,
  mainName,
  undoUntil,
  open: openBranch = (id: string) => window.location.assign(`/projects/${encodeURIComponent(id)}`),
}: {
  mainSiteId: string;
  branchId: string;
  branchName: string;
  mainName: string;
  /** Until when the merge can be undone (ISO). */
  undoUntil: string;
  /** Opens the new branch in the editor (a full navigation; tests replace it). */
  open?: (branchId: string) => void;
}) {
  const [shown, setShown] = useState(false);
  // The server said this merge can no longer be undone (it expired, another merge landed, an erase removed the
  // copy): the offer goes, and its reason stays on the page.
  const [ended, setEnded] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  if (ended) {
    return (
      <p role="alert" className="mx-auto mt-6 max-w-md text-sm text-muted-foreground">
        {ended}
      </p>
    );
  }

  return (
    <>
      <p className="mx-auto mt-6 max-w-md text-sm text-muted-foreground">
        Until {DATE.format(new Date(undoUntil))}, and as long as no other branch is merged into {mainName}, this merge can be
        undone.
      </p>
      <Button ref={trigger} type="button" variant="outline" className="mt-3" onClick={() => setShown(true)}>
        Undo this merge
      </Button>
      <UndoMergeDialog
        open={shown}
        onOpenChange={setShown}
        mainSiteId={mainSiteId}
        branchId={branchId}
        branchName={branchName}
        mainName={mainName}
        onUndone={openBranch}
        onEnded={setEnded}
        returnFocus={() => trigger.current?.focus()}
      />
    </>
  );
}
