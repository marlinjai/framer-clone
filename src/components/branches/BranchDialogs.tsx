'use client';

// src/components/branches/BranchDialogs.tsx
//
// Create, rename and discard a site branch (docs/plans/2026-11-10-site-branches.md, section 3, "An author").
// Each dialog says what went wrong in its own words and keeps the person's input, never a silent failure.

import React, { useEffect, useId, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
// Not crypto.randomUUID: browsers offer it only in a secure context, and the dialog is mounted with the editor.
import { v4 as uuidv4 } from 'uuid';
import { BRANCH_NAME_MAX_LENGTH, MAX_OPEN_BRANCHES_PER_SITE, validateBranchName } from '@/lib/sites/branches';
import { BranchApiError, branchClient, changeCountText } from '@/lib/sites/branchClient';
import { leaveClosedBranch, openSite, savedBeforeLeaving } from './leave';

/** Where the focus goes when a dialog closes: the control that opened it (the switcher), never the page. */
type ReturnFocus = { returnFocusTo?: React.RefObject<HTMLElement | null> };

function closeFocus(ref: ReturnFocus['returnFocusTo']) {
  return (e: Event) => {
    if (!ref?.current) return;
    e.preventDefault();
    ref.current.focus();
  };
}

function messageOf(err: unknown): string {
  if (err instanceof BranchApiError) return err.message;
  return 'Something went wrong. Nothing was changed; try again.';
}

function NameField({ id, value, onChange, error, describedBy }: { id: string; value: string; onChange: (v: string) => void; error: string | null; describedBy?: string }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Branch name
      </label>
      <input
        id={id}
        value={value}
        maxLength={BRANCH_NAME_MAX_LENGTH * 2}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? `${id}-error` : null, describedBy].filter(Boolean).join(' ') || undefined}
        className="h-9 rounded-md border bg-background px-3 text-sm"
        autoFocus
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * How many branches a site may have open, and how many it has, said before the person types a name. `count` is
 * undefined while it is not known: the limit alone is said then.
 */
export function branchLimitText(siteName: string, count: number | undefined): { text: string; reached: boolean } {
  const max = MAX_OPEN_BRANCHES_PER_SITE;
  if (count === undefined) return { text: `A site can have up to ${max} open branches at a time.`, reached: false };
  if (count >= max) {
    return {
      text: `${siteName} already has ${max} open branches, the most a site can have. Merge or discard one of them, then make a new one.`,
      reached: true,
    };
  }
  if (count === 0) return { text: `${siteName} has no open branch yet. A site can have up to ${max} at a time.`, reached: false };
  return { text: `${count} of ${max} branches are open on ${siteName}.`, reached: false };
}

/** "New branch": a copy of main's working copy as stored now, opened in the editor. */
export function NewBranchDialog({ open, onOpenChange, mainSiteId, fromSiteId, siteName, openBranches, openBranchesAreCurrent = false, returnFocusTo }: ReturnFocus & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mainSiteId: string;
  /** The site open now, saved before the new branch opens. */
  fromSiteId: string;
  /** The name of the site the branch is a copy of (main's name, also when the dialog is opened on a branch). */
  siteName: string;
  /** How many branches of the site are open, when the switcher knows. */
  openBranches?: number;
  /**
   * Whether that number was just read from the server. Only then does the limit turn "Create branch" off: a
   * number from when the editor was opened may be out of date, and the server decides in any case.
   */
  openBranchesAreCurrent?: boolean;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per dialog opening: a retry after a lost answer finds the branch it made, never a second one.
  const [branchId, setBranchId] = useState(() => uuidv4());
  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setBranchId(uuidv4());
    }
  }, [open]);
  const limit = branchLimitText(siteName, openBranches);
  const full = limit.reached && openBranchesAreCurrent;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Enter in the name field submits the form whatever the button says: the limit is kept here too.
    if (full) return;
    const checked = validateBranchName(name);
    if (!checked.ok) return setError(checked.message);
    setBusy(true);
    setError(null);
    try {
      if (!(await savedBeforeLeaving(fromSiteId))) {
        setError('This tab’s changes are not saved yet. The save status says why; the branch is made once they are.');
        return;
      }
      const { branch } = await branchClient.create(mainSiteId, checked.name, branchId);
      openSite(branch.branchId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={closeFocus(returnFocusTo)}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
            <DialogDescription>
              A copy of {siteName} as it is saved now. Change it without touching {siteName}, then merge it back. A branch
              is never published by itself.
            </DialogDescription>
          </DialogHeader>
          <NameField id={id} value={name} onChange={setName} error={error} describedBy={`${id}-limit`} />
          {/* The limit and where the site stands, before the server has to refuse. At the limit it is the reason
              "Create branch" is off, as text everyone can read. */}
          <p id={`${id}-limit`} data-limit-reached={full ? '' : undefined} className={`text-sm ${full ? 'text-destructive' : 'text-muted-foreground'}`}>
            {limit.text}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            {/* At the limit not `disabled`: the button stays reachable by keyboard, says why, and does nothing. */}
            <Button
              type="submit"
              disabled={busy}
              aria-disabled={full ? true : undefined}
              aria-describedby={full ? `${id}-limit` : undefined}
              className={full ? 'cursor-not-allowed opacity-50' : undefined}
            >
              {busy ? 'Creating…' : 'Create branch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rename the open branch (its record; the site's own name is a site setting). */
export function RenameBranchDialog({ open, onOpenChange, mainSiteId, branchId, current, onRenamed, returnFocusTo }: ReturnFocus & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mainSiteId: string;
  branchId: string;
  current: string;
  onRenamed: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(current);
      setError(null);
    }
  }, [open, current]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const checked = validateBranchName(name);
    if (!checked.ok) return setError(checked.message);
    setBusy(true);
    try {
      await branchClient.change(mainSiteId, branchId, { name: checked.name });
      onRenamed();
      onOpenChange(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={closeFocus(returnFocusTo)}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Rename branch</DialogTitle>
            <DialogDescription>The branch’s name in the switcher and the review. The site’s own name does not change.</DialogDescription>
          </DialogHeader>
          <NameField id={id} value={name} onChange={setName} error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function discardText(lost: { kind: 'loading' } | { kind: 'known'; text: string } | { kind: 'unknown' }): string {
  if (lost.kind === 'loading') return 'Counting the changes on this branch…';
  if (lost.kind === 'unknown') return 'The changes on this branch could not be counted just now; all of them will be lost.';
  if (lost.text === 'No changes yet') return 'This branch holds no changes yet.';
  return `${lost.text} on this branch will be lost.`;
}

/** Discard the open branch, naming how much is lost, then go to main. */
export function DiscardBranchDialog({ open, onOpenChange, mainSiteId, branchId, name, returnFocusTo }: ReturnFocus & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mainSiteId: string;
  branchId: string;
  name: string;
}) {
  // What is lost: being counted, counted, or not countable (the discard still works).
  const [lost, setLost] = useState<{ kind: 'loading' } | { kind: 'known'; text: string } | { kind: 'unknown' }>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setLost({ kind: 'loading' });
    let live = true;
    branchClient
      .changes(branchId)
      .then((review) => live && setLost({ kind: 'known', text: changeCountText(review.branchChanges) }))
      .catch(() => live && setLost({ kind: 'unknown' }));
    return () => {
      live = false;
    };
  }, [open, branchId]);

  async function discard() {
    setBusy(true);
    setError(null);
    try {
      await branchClient.discard(mainSiteId, branchId);
      leaveClosedBranch(branchId, mainSiteId);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={closeFocus(returnFocusTo)}>
        <DialogHeader>
          <DialogTitle>Discard “{name}”?</DialogTitle>
          <DialogDescription aria-busy={lost.kind === 'loading'}>
            {discardText(lost)} The site itself does not change. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it
          </Button>
          <Button type="button" variant="destructive" onClick={discard} disabled={busy}>
            {busy ? 'Discarding…' : 'Discard branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
