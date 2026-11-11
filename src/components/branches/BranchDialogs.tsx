'use client';

// src/components/branches/BranchDialogs.tsx
//
// Create, rename and discard a site branch (docs/plans/2026-11-10-site-branches.md, section 3, "An author").
// Each dialog says what went wrong in its own words and keeps the person's input, never a silent failure.

import React, { useEffect, useId, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { BRANCH_NAME_MAX_LENGTH, validateBranchName } from '@/lib/sites/branches';
import { BranchApiError, branchClient, changeCountText } from '@/lib/sites/branchClient';
import { leaveClosedBranch, openSite, savedBeforeLeaving } from './leave';

function messageOf(err: unknown): string {
  if (err instanceof BranchApiError) return err.message;
  return 'Something went wrong. Nothing was changed; try again.';
}

function NameField({ id, value, onChange, error }: { id: string; value: string; onChange: (v: string) => void; error: string | null }) {
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
        aria-describedby={error ? `${id}-error` : undefined}
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

/** "New branch": a copy of main's working copy as stored now, opened in the editor. */
export function NewBranchDialog({ open, onOpenChange, mainSiteId, fromSiteId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mainSiteId: string;
  /** The site open now, saved before the new branch opens. */
  fromSiteId: string;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per dialog opening: a retry after a lost answer finds the branch it made, never a second one.
  const [branchId, setBranchId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setBranchId(crypto.randomUUID());
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
            <DialogDescription>
              A copy of the site as it is saved now. Change it without touching the site, then merge it back. A branch is
              never published by itself.
            </DialogDescription>
          </DialogHeader>
          <NameField id={id} value={name} onChange={setName} error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create branch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rename the open branch (its record; the site's own name is a site setting). */
export function RenameBranchDialog({ open, onOpenChange, mainSiteId, branchId, current, onRenamed }: {
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
      <DialogContent>
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
export function DiscardBranchDialog({ open, onOpenChange, mainSiteId, branchId, name }: {
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
      <DialogContent>
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
