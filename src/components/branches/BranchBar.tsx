'use client';

// src/components/branches/BranchBar.tsx
//
// What the top bar shows on a site branch (docs/plans/2026-11-10-site-branches.md, section 3, "An author"):
// the badge, "Main has changed" with Update, and "Review and merge" in place of Publish (a branch is never
// published; publishing happens from main). "Review and merge" opens the review page (slice S5); an update that
// meets conflicts leaves the branch as it is and points there, where each one is answered.

import SharePreview from './SharePreview';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { getHistoryStore } from '@/stores/RootStore';
import { useStore } from '@/hooks/useStore';
import { abandonWorkingCopy } from '@/lib/projects/autosave';
import { isOpenBranchStatus } from '@/lib/sites/branches';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import SaveAsNewProjectDialog from '@/components/SaveAsNewProjectDialog';
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
  // The review calls these questions; so does this.
  return n === 1 ? 'The same thing was changed on main and on this branch: 1 question needs an answer first' : `The same things were changed on main and on this branch: ${n} questions need an answer first`;
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
  if (state?.kind !== 'branch' || !state.branch.mainMoved || !isOpenBranchStatus(state.branch.status)) {
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
      {/* Only the idle label gives way on a narrow window; a result or a refusal is always shown. */}
      <span className={`text-muted-foreground ${message ? '' : 'max-xl:hidden'}`}>{message ?? `${mainName} has changed`}</span>
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
        <RefreshCw aria-hidden className={busy ? 'animate-spin motion-reduce:animate-none' : undefined} /> {busy ? 'Updating…' : 'Update'}
      </Button>
    </div>
  );
}

/**
 * "Review and merge", in place of Publish on a branch: saves this tab's work, then opens the review (slice S5),
 * where the changes, the questions and the merge are.
 */
/**
 * A tab open on a branch that someone else merged or discarded (plan section 6): says what happened and offers
 * what is still possible. Nothing can be saved to a closed branch, so the work only this tab holds would be
 * lost without a word: it can be kept as a project of its own, or left, and the site is one click away.
 * "Keep looking" closes the dialog; the top bar keeps saying the branch is closed.
 */
export const BranchClosedElsewhere = observer(function BranchClosedElsewhere() {
  const { state } = useSiteBranch();
  const rootStore = useStore();
  const [dismissed, setDismissed] = useState(false);
  const [saveAs, setSaveAs] = useState(false);
  if (state?.kind !== 'branch') return null;
  const status = state.branch.status;
  if (status !== 'merged' && status !== 'discarded') return null;
  const project = rootStore.editorUI.currentProject;
  const { mainSiteId, mainName, branch } = state;
  const what = status === 'merged' ? `was merged into ${mainName}` : 'was discarded';
  return (
    <>
      <span role="status" className="mr-2 shrink-0 text-xs text-destructive">
        This branch {what}.{' '}
        <button type="button" className="underline" onClick={() => setDismissed(false)}>
          What now?
        </button>
      </span>
      <Dialog open={!dismissed && !saveAs} onOpenChange={(open) => setDismissed(!open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>The branch “{branch.name}” {what}</DialogTitle>
            <DialogDescription>
              Someone closed this branch while it was open in this tab, so nothing more can be saved to it.{' '}
              {status === 'merged'
                ? `What the branch held when it was merged is in ${mainName} now.`
                : 'What the branch held is gone.'}{' '}
              Anything changed in this tab since its last save is only here: keep it as a project of its own, or leave it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDismissed(true)}>
              Keep looking
            </Button>
            {project ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setSaveAs(true)}>
                Save this tab’s copy as a new project
              </Button>
            ) : null}
            <Button asChild size="sm">
              <a href={`/projects/${encodeURIComponent(mainSiteId)}`}>Open {mainName}</a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {project && saveAs ? (
        <SaveAsNewProjectDialog
          open={saveAs}
          onOpenChange={setSaveAs}
          defaultName={`${branch.name} (copy)`}
          getSnapshot={() => getSnapshot(project) as unknown as { pages: Record<string, unknown>; components: Record<string, unknown> }}
          currentPageId={rootStore.editorUI.currentPage?.id}
          onSaved={() => abandonWorkingCopy(project.id)}
          description="This tab’s pages and components become a new project in your company, and it opens in the editor. The closed branch stays closed."
        />
      ) : null}
    </>
  );
});

/**
 * On a branch whose "update from main" this tab undid: says what that means, with the way back. The branch still
 * counts as up to date with main, so merging it like this would take main's changes out of main (plan section
 * 6, path 2). Shown until the step is redone or the tab is reloaded.
 */
export const UpdateUndoneNote = observer(function UpdateUndoneNote({ className = '' }: { className?: string }) {
  const { state } = useSiteBranch();
  const history = getHistoryStore();
  if (state?.kind !== 'branch' || !history?.undoneUpdateId) return null;
  const canRedo = history.canRedo && history.history[history.undoIdx]?.id === history.undoneUpdateId;
  return (
    <div role="alert" className={`flex shrink-0 items-center gap-2 text-xs text-destructive ${className}`}>
      <span className="max-w-[26rem]">
        You undid the changes brought in from {state.mainName}. Merging this branch now would take them out of {state.mainName} too.
      </span>
      {canRedo ? (
        <Button size="sm" variant="outline" onClick={() => history.redo()}>
          Bring them back
        </Button>
      ) : null}
    </div>
  );
});

/** On a branch: "Share preview", the public preview link (S8). Whether the person may is the server's answer. */
export function SharePreviewButton({ className }: { className?: string }) {
  const { state } = useSiteBranch();
  if (state?.kind !== 'branch' || !isOpenBranchStatus(state.branch.status)) return null;
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
  // A branch closed elsewhere has nothing left to review or merge (BranchClosedElsewhere says what happened).
  if (state?.kind !== 'branch' || !isOpenBranchStatus(state.branch.status)) return null;
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
