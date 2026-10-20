'use client';
// src/app/projects/DeleteProjectDialog.tsx
//
// The confirmation for deleting a project (dashboard card menu, "Delete
// project"). It names the project and says exactly what happens: the project
// and its pages are deleted for good (there is no restore), a published site
// goes offline at once, connected custom domains are disconnected, and the
// company's own data (CMS collections, shop catalog and orders, Books, the
// analytics project) stays. A PUBLISHED project needs its name typed; an
// unpublished one is a plain confirm. The dialog stays open on failure with
// the reason; one delete at a time.

import React, { useEffect, useId, useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { deleteProject } from '@/lib/projects/deleteProject';

export interface DeleteProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  name: string;
  published: boolean;
  /** `<label>.sites.lumitra.co` once the project has a published address. */
  liveHost: string | null;
  customDomains: string[];
  /** Called after the project is gone (also when it was already gone). */
  onDeleted: () => void;
  /** Where keyboard focus goes when the dialog closes. */
  returnFocusTo: () => HTMLElement | null;
}

export default function DeleteProjectDialog({
  open,
  onOpenChange,
  siteId,
  name,
  published,
  liveHost,
  customDomains,
  onDeleted,
  returnFocusTo,
}: DeleteProjectDialogProps) {
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the project turned out to be gone already (or was deleted but a
  // cached copy may linger): the dialog says so, and closing it removes the card.
  const [goneNotice, setGoneNotice] = useState<string | null>(null);
  // The name to confirm against: the card's, or the newer one the server
  // reported when someone renamed the project in the meantime.
  const [expectedName, setExpectedName] = useState(name);
  const inputId = useId();
  const errorId = useId();

  // A fresh start every time the dialog opens.
  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
      setGoneNotice(null);
      setExpectedName(name);
    }
  }, [open, name]);

  const confirmed = !published || typed === expectedName;
  const shownName = expectedName || 'Untitled Project';

  const run = async () => {
    if (!confirmed || deleting) return;
    setDeleting(true);
    setError(null);
    const result = await deleteProject(siteId, published ? typed : undefined);
    setDeleting(false);
    if (result.ok) {
      onDeleted();
      return;
    }
    if (result.gone) {
      setGoneNotice(result.message);
      return;
    }
    if (result.currentName !== undefined) {
      setExpectedName(result.currentName);
      setTyped('');
    }
    setError(result.message);
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Never close mid-request: the outcome must be seen.
        if (deleting) return;
        if (!next && goneNotice) {
          onDeleted();
          return;
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={(e) => {
          if (deleting) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          const target = returnFocusTo();
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{shownName}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>
                This deletes the project and all of its pages permanently. It cannot be undone or
                restored.
              </p>
              {published ? (
                <p>
                  The published site
                  {liveHost ? (
                    <>
                      {' '}at <span className="font-medium text-foreground">{liveHost}</span>
                    </>
                  ) : null}{' '}
                  goes offline right away; visitors get a &ldquo;not found&rdquo; page.
                </p>
              ) : liveHost ? (
                <p>
                  Its address <span className="font-medium text-foreground">{liveHost}</span> is
                  released.
                </p>
              ) : null}
              {customDomains.length > 0 ? (
                <div>
                  <p>These custom domains are disconnected and stop serving this site:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {customDomains.map((d) => (
                      <li key={d} className="font-medium text-foreground">
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p>
                Your company&rsquo;s CMS collections, shop catalog, orders, Books and analytics are
                not affected.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {goneNotice ? (
          <div className="flex flex-col gap-4">
            <p role="alert" className="text-[13px]">
              {goneNotice}
            </p>
            <AlertDialogFooter>
              <Button type="button" size="sm" onClick={onDeleted}>
                Close
              </Button>
            </AlertDialogFooter>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
            className="flex flex-col gap-4"
          >
            {published ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={inputId} className="text-[13px]">
                  Type <span className="font-semibold">{expectedName}</span> to confirm
                </label>
                <input
                  id={inputId}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  disabled={deleting}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-brand"
                />
              </div>
            ) : null}

            {error ? (
              <p id={errorId} role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            ) : null}

            <AlertDialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={deleting}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={!confirmed || deleting}
                aria-busy={deleting || undefined}
              >
                {deleting ? 'Deleting…' : 'Delete project'}
              </Button>
            </AlertDialogFooter>
          </form>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
