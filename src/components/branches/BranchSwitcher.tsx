'use client';

// src/components/branches/BranchSwitcher.tsx
//
// The branch switcher next to the site name (docs/plans/2026-11-10-site-branches.md, section 3): main and the
// open branches, "New branch", and on a branch its rename, ready state and discard. Shown only while site
// branches are on for the company (the editor route passes no state otherwise). Each branch has its own
// address; the switcher saves this tab's work before it leaves.

import React, { useRef, useState } from 'react';
import { Check, GitBranch, ChevronDown, Plus, Pencil, Trash2, Send, Undo2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSiteBranch } from '@/contexts/SiteBranchContext';
import type { BranchSummaryJson } from '@/lib/sites/branches';
import { BranchApiError, branchClient } from '@/lib/sites/branchClient';
import { DiscardBranchDialog, NewBranchDialog, RenameBranchDialog } from './BranchDialogs';
import { openSite, savedBeforeLeaving } from './leave';

type Listed = { kind: 'loading' } | { kind: 'ok'; open: BranchSummaryJson[] } | { kind: 'failed'; message: string };

export default function BranchSwitcher({ className = '' }: { className?: string }) {
  const { state, refresh } = useSiteBranch();
  const [listed, setListed] = useState<Listed>({ kind: 'loading' });
  const [dialog, setDialog] = useState<null | 'new' | 'rename' | 'discard'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A dialog opens once the menu has CLOSED (as in ProjectCard): while the menu is open it traps focus, so a
  // dialog opened from its item would lose focus to the trigger straight away.
  const chosen = useRef<'new' | 'rename' | 'discard' | null>(null);
  // Where a dialog opened from the menu gives the focus back when it closes.
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!state) return null;

  const mainSiteId = state.kind === 'main' ? state.siteId : state.mainSiteId;
  const onBranch = state.kind === 'branch' ? state.branch : null;
  const label = onBranch ? onBranch.name : 'Main';

  async function load() {
    setListed({ kind: 'loading' });
    try {
      const list = await branchClient.list(mainSiteId);
      setListed({ kind: 'ok', open: list.open });
    } catch (err) {
      setListed({ kind: 'failed', message: err instanceof BranchApiError ? err.message : 'The branches could not be loaded.' });
    }
  }

  async function go(siteId: string) {
    if (siteId === state!.siteId) return;
    if (!(await savedBeforeLeaving(state!.siteId))) {
      setNotice('This tab’s changes are not saved yet. The save status says why.');
      return;
    }
    openSite(siteId);
  }

  async function setReady(ready: boolean) {
    if (!onBranch) return;
    try {
      await branchClient.change(mainSiteId, onBranch.branchId, { ready });
      await refresh();
      setNotice(ready ? 'Marked ready for review.' : 'Back to open.');
    } catch (err) {
      setNotice(err instanceof BranchApiError ? err.message : 'That did not work. Try again.');
    }
  }

  return (
    <>
      <DropdownMenu modal={false} onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger
          ref={triggerRef}
          className={`flex h-8 max-w-[180px] shrink-0 items-center gap-1 rounded px-2 text-sm hover:bg-accent ${onBranch ? 'bg-accent font-medium' : 'text-muted-foreground'} ${className}`}
          aria-label={onBranch ? `Branch ${label}. Switch branch` : 'Main. Switch branch'}
        >
          <GitBranch size={14} aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDown size={14} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          data-editor-ui="true"
          className="z-[1100] w-64"
          onCloseAutoFocus={(e) => {
            const next = chosen.current;
            chosen.current = null;
            if (next) {
              e.preventDefault();
              setDialog(next);
            }
          }}
        >
          <DropdownMenuLabel>Branches</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void go(mainSiteId)}>
            {state.kind === 'main' ? <Check aria-hidden /> : <span className="w-4" aria-hidden />} Main
          </DropdownMenuItem>
          {listed.kind === 'loading' ? (
            <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          ) : listed.kind === 'failed' ? (
            <DropdownMenuItem disabled>{listed.message}</DropdownMenuItem>
          ) : (
            listed.open.map((b) => (
              <DropdownMenuItem key={b.branchId} onSelect={() => void go(b.branchId)}>
                {b.branchId === state.siteId ? <Check aria-hidden /> : <span className="w-4" aria-hidden />}
                <span className="truncate">{b.name}</span>
                {b.status === 'ready' ? <span className="ml-auto text-xs text-muted-foreground">{b.approved ? 'Approved' : 'Ready'}</span> : null}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => (chosen.current = 'new')}>
            <Plus aria-hidden /> New branch…
          </DropdownMenuItem>
          {onBranch ? (
            <>
              <DropdownMenuItem onSelect={() => (chosen.current = 'rename')}>
                <Pencil aria-hidden /> Rename branch…
              </DropdownMenuItem>
              {onBranch.status === 'ready' ? (
                <DropdownMenuItem onSelect={() => void setReady(false)}>
                  <Undo2 aria-hidden /> Back to open
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => void setReady(true)}>
                  <Send aria-hidden /> Mark ready for review
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onSelect={() => (chosen.current = 'discard')}>
                <Trash2 aria-hidden /> Discard branch…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" aria-live="polite" className="sr-only">
        {notice ?? ''}
      </span>
      <NewBranchDialog open={dialog === 'new'} onOpenChange={(o) => setDialog(o ? 'new' : null)} mainSiteId={mainSiteId} fromSiteId={state.siteId} returnFocusTo={triggerRef} />
      {onBranch ? (
        <>
          <RenameBranchDialog
            open={dialog === 'rename'}
            onOpenChange={(o) => setDialog(o ? 'rename' : null)}
            mainSiteId={mainSiteId}
            branchId={onBranch.branchId}
            current={onBranch.name}
            onRenamed={() => void refresh()}
            returnFocusTo={triggerRef}
          />
          <DiscardBranchDialog
            open={dialog === 'discard'}
            onOpenChange={(o) => setDialog(o ? 'discard' : null)}
            mainSiteId={mainSiteId}
            branchId={onBranch.branchId}
            name={onBranch.name}
            returnFocusTo={triggerRef}
          />
        </>
      ) : null}
    </>
  );
}
