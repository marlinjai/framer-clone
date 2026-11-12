'use client';

// src/components/branches/UndoMerge.tsx
//
// "Undo this merge" on a merged branch's old address (docs/plans/2026-11-10-site-branches.md, section 3,
// "Afterwards", slice S7). The dialog says what the undo does before it does it: the site goes back to what it
// was before the merge, and everything the site holds now, the merged work and any change made since, moves to
// a new branch. Nothing is published either way. On success the editor opens the new branch.

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server said this merge can no longer be undone (it expired, another merge landed, an erase removed the
  // copy): the offer goes, and its reason stays on the page.
  const [ended, setEnded] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      const outcome = await branchClient.undoMerge(mainSiteId, branchId);
      openBranch(outcome.branch.branchId);
    } catch (err) {
      setBusy(false);
      if (err instanceof BranchApiError && err.code === 'merge_undo_unavailable') {
        setEnded(err.message);
        setShown(false);
        return;
      }
      setError(undoErrorText(err));
    }
  }

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
      <Dialog
        open={shown}
        onOpenChange={(next) => {
          if (busy) return;
          setShown(next);
          if (!next) setError(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
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
            <Button type="button" variant="outline" onClick={() => setShown(false)} disabled={busy}>
              Keep the merge
            </Button>
            <Button type="button" onClick={undo} disabled={busy}>
              {busy ? 'Undoing…' : 'Undo the merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
