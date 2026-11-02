// src/components/PublishedVersionsButton.tsx
//
// The editor's "Published versions": the versions of this site that visitors
// have been served, newest first, and "Make live" to go back to one (plan
// docs/plans/2026-11-01-immutable-published-copy.md). Going back changes the live
// site and nothing in the editor. It asks first, in the dialog: it changes what
// visitors see at once, on an offline site it goes back on the internet, and the
// legal warnings of src/lib/legal/publishCheck.ts are shown for that version.
// A warning, never a gate, and a check that fails does not block the way back.
//
// The list mounts only while the dialog is open, so every open loads the
// server's current list. Every failure is shown, with a retry for the list.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { RefreshCw, Undo } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useStore } from '@/hooks/useStore';
import { useControllableOpen, type ControllableOpenProps } from '@/hooks/useControllableOpen';
import { hasPublishIssues, type PublishCheck } from '@/lib/legal/publishCheck';

interface VersionItem {
  number: number;
  kind: 'publish' | 'baseline';
  createdAt: string;
}

interface VersionList {
  live: number | null;
  status: string;
  revisions: VersionItem[];
}

/** The version waiting for a yes, and what its check found. */
type Confirm =
  | { number: number; check: 'loading' | 'failed' }
  | { number: number; check: PublishCheck };

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; list: VersionList };

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return `${fallback}: ${body.error.message}`;
  } catch {
    // not JSON
  }
  return `${fallback} (HTTP ${res.status})`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function ConfirmMakeLive({ confirm, online, onConfirm, onCancel }: {
  confirm: Confirm;
  online: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { number, check } = confirm;
  return (
    <div role="group" aria-label={`Confirm version ${number}`} className="space-y-2 rounded border border-border p-3">
      <p className="text-sm font-medium">
        {online
          ? `Make version ${number} live? Visitors see it at once.`
          : `Put this site back online with version ${number}? It is on the internet again at once.`}
      </p>
      {check === 'loading' && <p className="text-sm text-muted-foreground">Checking the legal pages...</p>}
      {check === 'failed' && <p className="text-sm text-muted-foreground">The legal pages of this version could not be checked.</p>}
      {typeof check === 'object' && hasPublishIssues(check) && (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {check.missingImpressum && <li>This version has business data but no Impressum page.</li>}
          {check.placeholders.map((issue) => (
            <li key={issue.pageId}>
              {issue.title} still has {issue.count} {issue.count === 1 ? 'placeholder' : 'placeholders'}.
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={check === 'loading'} onClick={onConfirm}>
          {online ? 'Make live' : 'Put back online'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function VersionsPanel({ projectId }: { projectId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/revisions`);
      if (!res.ok) {
        setLoad({ kind: 'error', message: await readError(res, 'Could not load the published versions') });
        return;
      }
      setLoad({ kind: 'ready', list: (await res.json()) as VersionList });
    } catch {
      setLoad({ kind: 'error', message: 'Could not load the published versions: network error.' });
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const askToMakeLive = async (number: number) => {
    setFailure(null);
    setConfirm({ number, check: 'loading' });
    let check: PublishCheck | 'failed' = 'failed';
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/revisions/${number}`);
      if (res.ok) check = ((await res.json()) as { check: PublishCheck }).check;
    } catch {
      // Shown as "could not be checked"; going back must stay possible.
    }
    setConfirm((current) => (current?.number === number ? { number, check } : current));
  };

  const makeLive = async (number: number) => {
    setConfirm(null);
    setBusy(number);
    setFailure(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ number }),
      });
      if (!res.ok) {
        setFailure(await readError(res, `Could not make version ${number} live`));
        return;
      }
      await refresh();
    } catch {
      setFailure(`Could not make version ${number} live: network error.`);
    } finally {
      setBusy(null);
    }
  };

  if (load.kind === 'loading') return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (load.kind === 'error') {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">{load.message}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw size={14} /> Try again
        </Button>
      </div>
    );
  }

  const { list } = load;
  const online = list.status === 'published';
  if (list.revisions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {online
          ? 'This site went live before versions were kept. Its first version is recorded with your next Save or Publish.'
          : 'Nothing published yet. Each Publish is kept here.'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
      {!online && <p className="text-sm text-muted-foreground">This site is offline. Making a version live puts it back on the internet.</p>}
      {confirm && (
        <ConfirmMakeLive
          confirm={confirm}
          online={online}
          onConfirm={() => void makeLive(confirm.number)}
          onCancel={() => setConfirm(null)}
        />
      )}
      <ul className="divide-y divide-border">
        {list.revisions.map((revision) => {
          const live = online && revision.number === list.live;
          return (
            <li key={revision.number} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  Version {revision.number}
                  {live && <span className="ml-2 text-xs font-normal text-brand">Live</span>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {formatDate(revision.createdAt)}
                  {revision.kind === 'baseline' && ' · what the site showed before versions were kept'}
                </div>
              </div>
              {!live && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || confirm !== null}
                  onClick={() => void askToMakeLive(revision.number)}
                >
                  {busy === revision.number ? 'Working...' : 'Make live'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface PublishedVersionsButtonProps extends ControllableOpenProps {
  /** Extra classes for the trigger (the compact top bar hides it and opens the dialog from its More menu). */
  triggerClassName?: string;
}

const PublishedVersionsButton = observer(({ open: openProp, onOpenChange, triggerClassName = '' }: PublishedVersionsButtonProps) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const [open, setOpen] = useControllableOpen({ open: openProp, onOpenChange });
  // The demo editor's project exists only in this browser: nothing was published.
  if (!project || editorUI.isUnsavedDemo) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Published versions"
        aria-label="Published versions"
        className={`mr-2 flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-accent ${triggerClassName}`}
      >
        <Undo size={16} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-editor-ui="true" className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Published versions</DialogTitle>
            <DialogDescription>
              Visitors see the version marked Live; saving never changes it. Making an older version live leaves the editor as it is, so your next Publish replaces it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>{open && <VersionsPanel projectId={project.id} />}</DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
});

PublishedVersionsButton.displayName = 'PublishedVersionsButton';
export default PublishedVersionsButton;
