'use client';

// src/components/branches/BranchBar.tsx
//
// What the top bar shows on a site branch (docs/plans/2026-11-10-site-branches.md, section 3, "An author"):
// the badge, "Main has changed" with Update, and "Review and merge" in place of Publish (a branch is never
// published; publishing happens from main). The review dialog here is the compact one of slice S4: what the
// branch changes, and Merge when nothing needs an answer. Conflicts are named with their count; answering them
// one by one is the review of slice S5.

import React, { useEffect, useState } from 'react';
import { GitMerge, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSiteBranch } from '@/contexts/SiteBranchContext';
import { BranchApiError, branchClient, changeCountText, type BranchReviewJson } from '@/lib/sites/branchClient';
import { openSite, savedBeforeLeaving } from './leave';

function messageOf(err: unknown): string {
  if (err instanceof BranchApiError) return err.message;
  return 'Something went wrong. Nothing was changed; try again.';
}

function conflictText(n: number): string {
  return n === 1 ? 'Main’s changes and this branch’s conflict in 1 place' : `Main’s changes and this branch’s conflict in ${n} places`;
}

/** The branch's name and state, beside the switcher. */
export function BranchBadge({ className = '' }: { className?: string }) {
  const { state } = useSiteBranch();
  if (state?.kind !== 'branch') return null;
  const { branch } = state;
  const label = branch.status === 'ready' ? (branch.approved ? 'Approved' : 'Ready for review') : 'Branch';
  return (
    <span
      className={`shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300 ${className}`}
      title={`A branch of ${state.mainName}. It is never published; merge it into ${state.mainName} to publish its changes.`}
    >
      {label}
    </span>
  );
}

/** "Main has changed" with Update: brings main's changes into the branch. */
export function MainChangedNote({ className = '' }: { className?: string }) {
  const { state, refresh } = useSiteBranch();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (state?.kind !== 'branch' || !state.branch.mainMoved) {
    return message ? (
      <span role="status" className={`text-xs text-muted-foreground ${className}`}>
        {message}
      </span>
    ) : null;
  }
  const { siteId, mainName } = state;

  async function update() {
    setBusy(true);
    setMessage(null);
    try {
      if (!(await savedBeforeLeaving(siteId))) {
        setMessage('This tab’s changes are not saved yet. The save status says why.');
        return;
      }
      const review = await branchClient.changes(siteId);
      if (review.conflicts.length > 0) {
        setMessage(`${conflictText(review.conflicts.length)}. Answer them in Review and merge.`);
        return;
      }
      await branchClient.update(siteId, review.token);
      // The branch's stream announces the write (origin 'update'); the editor adopts it like any other.
      await refresh();
      setMessage(`Updated from ${mainName}.`);
    } catch (err) {
      setMessage(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="status" className={`flex shrink-0 items-center gap-2 text-xs ${className}`}>
      <span className="text-muted-foreground max-xl:hidden">{message ?? `${mainName} has changed`}</span>
      <Button size="sm" variant="outline" onClick={update} disabled={busy} title={`Bring the changes made to ${mainName} into this branch`}>
        <RefreshCw aria-hidden className={busy ? 'animate-spin' : undefined} /> {busy ? 'Updating…' : 'Update'}
      </Button>
    </div>
  );
}

type Loaded = { kind: 'loading' } | { kind: 'ok'; review: BranchReviewJson } | { kind: 'failed'; message: string };

/** "Review and merge", in place of Publish on a branch. */
export function ReviewAndMergeButton() {
  const { state, refresh } = useSiteBranch();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const siteId = state?.kind === 'branch' ? state.siteId : null;

  useEffect(() => {
    if (!open || !siteId) return;
    let live = true;
    setLoaded({ kind: 'loading' });
    setError(null);
    (async () => {
      // The review is of what the server holds: save this tab's work first.
      if (!(await savedBeforeLeaving(siteId))) {
        if (live) setLoaded({ kind: 'failed', message: 'This tab’s changes are not saved yet. The save status says why.' });
        return;
      }
      const review = await branchClient.changes(siteId);
      if (live) setLoaded({ kind: 'ok', review });
    })().catch((err) => live && setLoaded({ kind: 'failed', message: messageOf(err) }));
    return () => {
      live = false;
    };
  }, [open, siteId]);

  if (state?.kind !== 'branch') return null;
  const { mainName, mainSiteId } = state;

  async function merge(review: BranchReviewJson) {
    setBusy(true);
    setError(null);
    try {
      await branchClient.merge(state!.siteId, review.token);
      openSite(mainSiteId);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
      // A refusal may have updated the branch first (`branch_updated_from_main`): show it as it is now.
      void refresh();
      if (err instanceof BranchApiError && (err.code === 'branch_updated_from_main' || err.code === 'branch_review_stale')) {
        setLoaded({ kind: 'loading' });
        branchClient.changes(state!.siteId).then(
          (next) => setLoaded({ kind: 'ok', review: next }),
          (e) => setLoaded({ kind: 'failed', message: messageOf(e) }),
        );
      }
    }
  }

  const review = loaded.kind === 'ok' ? loaded.review : null;
  const blocked = review ? review.conflicts.length > 0 || review.problems.length > 0 : true;
  const nothing = review ? changeCountText(review.branchChanges) === 'No changes yet' : false;

  return (
    <>
      <Button variant="brand" size="sm" className="mr-2 shrink-0" onClick={() => setOpen(true)} title={`Branches are never published. Merge into ${mainName}, then publish from there.`}>
        <GitMerge aria-hidden /> <span className="max-sm:sr-only">Review and merge</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review and merge into {mainName}</DialogTitle>
            <DialogDescription>
              Merging writes this branch’s changes into {mainName} and closes the branch. Publishing happens from {mainName} afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-sm" aria-live="polite" aria-busy={loaded.kind === 'loading'}>
            {loaded.kind === 'loading' ? <p className="text-muted-foreground">Reading the changes…</p> : null}
            {loaded.kind === 'failed' ? (
              <p role="alert" className="text-destructive">
                {loaded.message}
              </p>
            ) : null}
            {review ? (
              <>
                <p>
                  <span className="font-medium">This branch:</span> {changeCountText(review.branchChanges)}.
                </p>
                {review.mainChanges ? (
                  <p>
                    <span className="font-medium">{mainName} since the branch began:</span> {changeCountText(review.mainChanges)}. They are brought in first.
                  </p>
                ) : null}
                {review.conflicts.length > 0 ? (
                  <p role="alert" className="text-destructive">
                    {conflictText(review.conflicts.length)}. Each needs an answer before the merge.
                  </p>
                ) : null}
                {review.problems.map((p) => (
                  <p key={p.code + p.message} role="alert" className="text-destructive">
                    {p.message}
                  </p>
                ))}
              </>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Close
            </Button>
            <Button type="button" onClick={() => review && merge(review)} disabled={busy || blocked || nothing}>
              {busy ? 'Merging…' : `Merge into ${mainName}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
