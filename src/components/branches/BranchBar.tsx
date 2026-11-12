'use client';

// src/components/branches/BranchBar.tsx
//
// What the top bar shows on a site branch (docs/plans/2026-11-10-site-branches.md, section 3, "An author"):
// the badge, "Main has changed" with Update, and "Review and merge" in place of Publish (a branch is never
// published; publishing happens from main). "Review and merge" opens the review page (slice S5); an update that
// meets conflicts leaves the branch as it is and points there, where each one is answered.

import SharePreview from './SharePreview';
import React, { useState } from 'react';
import { GitMerge, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSiteBranch } from '@/contexts/SiteBranchContext';
import { BranchApiError, branchClient } from '@/lib/sites/branchClient';
import { openReview, savedBeforeLeaving } from './leave';

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
  const [conflicts, setConflicts] = useState(false);
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
    setConflicts(false);
    try {
      if (!(await savedBeforeLeaving(siteId))) {
        setMessage('This tab’s changes are not saved yet. The save status says why.');
        return;
      }
      const review = await branchClient.changes(siteId);
      if (review.conflicts.length > 0) {
        // Each conflict is answered in the review; until then the branch stays as it is.
        setMessage(`${conflictText(review.conflicts.length)}, so it was not updated. The branch is unchanged.`);
        setConflicts(true);
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
      {conflicts ? (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            // Leaving saves first (decision 48).
            if (await savedBeforeLeaving(siteId)) openReview(siteId);
            else setMessage('This tab’s changes are not saved yet. The save status says why.');
          }}
        >
          Answer in the review
        </Button>
      ) : null}
      <Button size="sm" variant="outline" onClick={update} disabled={busy} title={`Bring the changes made to ${mainName} into this branch`}>
        <RefreshCw aria-hidden className={busy ? 'animate-spin' : undefined} /> {busy ? 'Updating…' : 'Update'}
      </Button>
    </div>
  );
}

/**
 * "Review and merge", in place of Publish on a branch: saves this tab's work, then opens the review (slice S5),
 * where the changes, the questions and the merge are.
 */
/** On a branch: "Share preview", the public preview link (S8). Whether the person may is the server's answer. */
export function SharePreviewButton({ className }: { className?: string }) {
  const { state } = useSiteBranch();
  if (state?.kind !== 'branch') return null;
  return (
    <span className={className}>
      <SharePreview mainSiteId={state.mainSiteId} branchId={state.siteId} branchName={state.branch.name} />
    </span>
  );
}

export function ReviewAndMergeButton() {
  const { state } = useSiteBranch();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (state?.kind !== 'branch') return null;
  const { siteId, mainName } = state;

  async function open() {
    setBusy(true);
    setMessage(null);
    try {
      // The review is of what the server holds: save this tab's work first.
      if (await savedBeforeLeaving(siteId)) {
        openReview(siteId);
        return;
      }
      setMessage('This tab’s changes are not saved yet. The save status says why.');
    } catch (err) {
      setMessage(messageOf(err));
    }
    setBusy(false);
  }

  return (
    <>
      {message ? (
        <span role="alert" className="mr-2 text-xs text-destructive">
          {message}
        </span>
      ) : null}
      <Button
        variant="brand"
        size="sm"
        className="mr-2 shrink-0"
        onClick={open}
        disabled={busy}
        title={`Branches are never published. Merge into ${mainName}, then publish from there.`}
      >
        <GitMerge aria-hidden /> <span className="max-sm:sr-only">{busy ? 'Opening…' : 'Review and merge'}</span>
      </Button>
    </>
  );
}
