'use client';

// src/components/branches/BranchSwitcher.tsx
//
// The branch switcher next to the site name (docs/plans/2026-11-10-site-branches.md, section 3): main and the
// open branches, "New branch", and on a branch its rename, ready state and discard. Shown only while site
// branches are on for the company (the editor route passes no state otherwise). Each branch has its own
// address; the switcher saves this tab's work before it leaves.
//
// "Recently merged" (section 3, "Afterwards"): the few latest merged branches, each a way to its old address,
// which says what happened. The site's latest merge can be undone from here while the server still offers it
// (`undoUntil`), with the dialog and the request of the old address's own "Undo this merge" (UndoMerge.tsx). A
// merge that was undone says where its work went instead. Discarded branches are not listed: nothing of them
// is left to go to.

import React, { useId, useRef, useState } from 'react';
import { Check, GitBranch, GitMerge, ChevronDown, Plus, Pencil, Trash2, Send, Undo2 } from 'lucide-react';
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
import { BarMessage, branchExplanation } from './BranchBar';
import { DiscardBranchDialog, NewBranchDialog, RenameBranchDialog } from './BranchDialogs';
import { UndoMergeDialog } from './UndoMerge';
import { openSite, savedBeforeLeaving } from './leave';

type Listed = { kind: 'loading' } | { kind: 'ok'; open: BranchSummaryJson[]; closed: BranchSummaryJson[] } | { kind: 'failed'; message: string };
type Chosen = 'new' | 'rename' | 'discard' | 'undo';

/** How many merged branches the switcher lists: the latest few. The rest keep their old addresses. */
export const RECENTLY_MERGED_SHOWN = 3;

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });

/** One line of "Recently merged": what happened to the merge, where selecting it goes, and whether it can be undone. */
export interface MergedRow {
  branch: BranchSummaryJson;
  /** Under the name: when it was merged, or where its work went once the merge was undone. */
  detail: string;
  /** The site id selecting the line opens: the open branch that holds the work, or the merged branch's old address. */
  opens: string;
  canUndo: boolean;
}

/**
 * The latest merged branches of a listing, newest merge first. Whether a merge can still be undone is the
 * server's word (`undoUntil`), never this clock's. An undone merge names the branch that took the work: an
 * open one is where the line goes; a closed one is named, and the line goes to the old address, which says the rest.
 */
export function recentlyMerged(open: BranchSummaryJson[], closed: BranchSummaryJson[], shown = RECENTLY_MERGED_SHOWN): MergedRow[] {
  return closed
    .filter((b) => b.status === 'merged')
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))
    .slice(0, shown)
    .map((branch) => {
      if (branch.undoneIntoBranchId) {
        const holds = open.find((b) => b.branchId === branch.undoneIntoBranchId);
        if (holds) return { branch, detail: `Merge undone. Its changes are on the branch “${holds.name}” now.`, opens: holds.branchId, canUndo: false };
        const held = closed.find((b) => b.branchId === branch.undoneIntoBranchId);
        return {
          branch,
          detail: `Merge undone. Its changes went to ${held ? `the branch “${held.name}”` : 'another branch'}, which has been merged or discarded since.`,
          opens: branch.branchId,
          canUndo: false,
        };
      }
      return {
        branch,
        detail: branch.mergedAt ? `Merged on ${DATE.format(new Date(branch.mergedAt))}` : 'Merged',
        opens: branch.branchId,
        canUndo: branch.undoUntil !== null,
      };
    });
}

export default function BranchSwitcher({ className = '' }: { className?: string }) {
  const { state, refresh } = useSiteBranch();
  const [listed, setListed] = useState<Listed>({ kind: 'loading' });
  const [dialog, setDialog] = useState<null | Chosen>(null);
  // The merge "Undo this merge…" was chosen for. Kept while its dialog closes, so the dialog keeps its words.
  const [undoing, setUndoing] = useState<BranchSummaryJson | null>(null);
  const aboutId = useId();
  const [notice, setNotice] = useState<string | null>(null);
  // A dialog opens once the menu has CLOSED (as in ProjectCard): while the menu is open it traps focus, so a
  // dialog opened from its item would lose focus to the trigger straight away.
  const chosen = useRef<Chosen | null>(null);
  // Where a dialog opened from the menu gives the focus back when it closes.
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!state) return null;

  const mainSiteId = state.kind === 'main' ? state.siteId : state.mainSiteId;
  const onBranch = state.kind === 'branch' ? state.branch : null;
  const label = onBranch ? onBranch.name : 'Main';
  const mainName = state.kind === 'main' ? state.siteName : state.mainName;
  const merged = listed.kind === 'ok' ? recentlyMerged(listed.open, listed.closed) : [];
  // How many branches are open: the list just read when there is one, else what the editor was opened with.
  const openBranches = listed.kind === 'ok' ? listed.open.length : state.kind === 'main' ? state.openBranches : undefined;

  async function load() {
    setListed({ kind: 'loading' });
    try {
      const list = await branchClient.list(mainSiteId);
      setListed({ kind: 'ok', open: list.open, closed: list.closed ?? [] });
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
      setNotice(ready ? 'Marked ready for review.' : 'No longer marked ready for review.');
    } catch (err) {
      setNotice(err instanceof BranchApiError ? err.message : 'That did not work. Try again.');
    }
  }

  return (
    <>
      <DropdownMenu modal={false} onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger
          ref={triggerRef}
          // On a narrow window the name shortens before anything beside it is pushed out; the menu shows it in full.
          className={`flex h-8 min-w-[3.25rem] max-w-[180px] shrink items-center gap-1 rounded px-2 text-sm hover:bg-accent ${onBranch ? 'bg-accent font-medium' : 'text-muted-foreground'} ${className}`}
          aria-label={onBranch ? `Branch ${label}. Switch branch` : 'Main. Switch branch'}
        >
          <GitBranch size={14} aria-hidden className="shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDown size={14} aria-hidden className="shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          data-editor-ui="true"
          className="z-[1100] w-72 max-w-[calc(100vw-1rem)]"
          aria-describedby={onBranch ? aboutId : undefined}
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
          {/* What a branch is, where a keyboard and a touch screen reach it: the badge's own words (the badge
              says them only to a pointer that rests on it, and is not shown on a narrow window). */}
          {onBranch ? (
            <p id={aboutId} className="px-2 pb-1.5 text-xs text-muted-foreground">
              {branchExplanation(mainName)}
            </p>
          ) : null}
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
                {/* The whole name, on as many lines as it needs: the trigger shows a shortened one. */}
                <span className="min-w-0 break-words">{b.name}</span>
                {b.status === 'ready' ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{b.approved ? 'Approved' : 'Ready'}</span> : null}
              </DropdownMenuItem>
            ))
          )}
          {merged.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Recently merged</DropdownMenuLabel>
              {merged.map((row) => (
                <React.Fragment key={row.branch.branchId}>
                  <DropdownMenuItem className="items-start" onSelect={() => void go(row.opens)}>
                    <GitMerge aria-hidden className="mt-0.5" />
                    <span className="flex min-w-0 flex-col">
                      <span className="break-words">{row.branch.name}</span>
                      <span className="text-xs text-muted-foreground">{row.detail}</span>
                    </span>
                  </DropdownMenuItem>
                  {row.canUndo ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setUndoing(row.branch);
                        chosen.current = 'undo';
                      }}
                    >
                      <Undo2 aria-hidden /> <span className="min-w-0 break-words">Undo the merge of “{row.branch.name}”…</span>
                    </DropdownMenuItem>
                  ) : null}
                </React.Fragment>
              ))}
            </>
          ) : null}
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
                  <Undo2 aria-hidden /> Not ready for review yet
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
      {/* Seen as well as announced: a switch refused because the tab is not saved, or a failed "ready", would
          otherwise close the menu and show nothing. Always mounted, so a screen reader hears each new text. */}
      <span role="status" aria-live="polite" className={notice ? 'min-w-0 max-w-[22rem] shrink text-xs leading-tight text-muted-foreground' : 'sr-only'}>
        {/* Up to three lines where there is little room. The pointer's tooltip repeats the text; it sits on the
            inner element, since on the status itself it would become its name. */}
        {notice ? <BarMessage text={notice} /> : null}
      </span>
      <NewBranchDialog
        open={dialog === 'new'}
        onOpenChange={(o) => setDialog(o ? 'new' : null)}
        mainSiteId={mainSiteId}
        fromSiteId={state.siteId}
        siteName={mainName}
        openBranches={openBranches}
        openBranchesAreCurrent={listed.kind === 'ok'}
        returnFocusTo={triggerRef}
      />
      {undoing ? (
        <UndoMergeDialog
          open={dialog === 'undo'}
          onOpenChange={(o) => setDialog(o ? 'undo' : null)}
          mainSiteId={mainSiteId}
          branchId={undoing.branchId}
          branchName={undoing.name}
          mainName={mainName}
          // The undo moves what the site holds now to a new branch: what this tab has not saved goes first.
          before={async () =>
            (await savedBeforeLeaving(state.siteId)) ? null : 'This tab’s changes are not saved yet. The save status says why; the merge can be undone once they are.'
          }
          onUndone={(newBranchId) => openSite(newBranchId)}
          // The server's reason stays in the top bar, and the next opening of the menu no longer offers the undo.
          onEnded={(reason) => setNotice(reason)}
          returnFocus={() => triggerRef.current?.focus()}
        />
      ) : null}
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
