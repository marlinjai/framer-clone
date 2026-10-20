'use client';
// src/app/projects/DeleteProjectDialog.tsx
//
// The confirmation for deleting a project (dashboard card menu, "Delete
// project"). It names the project and says what happens: the project and its
// pages are deleted for good (there is no restore), a published site goes
// offline, connected custom domains are disconnected, and the company's own
// data (CMS collections, shop catalog and orders, Books, analytics) stays.
//
// A PUBLISHED project needs its name typed; an unpublished one is a plain
// confirm. The server has the last word: when the project was published or
// renamed since the page loaded, it refuses and the dialog switches to asking
// for the current name. The dialog stays open on failure with the reason, one
// delete runs at a time, and focus starts inside the dialog.

import React, { useEffect, useId, useRef, useState } from 'react';
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

const FALLBACK_NAME = 'Untitled Project';

export interface DeleteProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  name: string;
  published: boolean;
  /** `<label>.sites.lumitra.co` once the project has a published address. */
  liveHost: string | null;
  customDomains: string[];
  /** Called once the project is gone (also when it was already gone). */
  onDeleted: (announcement: string) => void;
  /** Where keyboard focus goes when the dialog closes without deleting. */
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
  // The project's real name (what the server compares against) and whether a
  // typed confirmation is needed. Both start from the card and follow the
  // server when it reports the project was renamed or published meanwhile.
  const [currentName, setCurrentName] = useState(name);
  const [needsName, setNeedsName] = useState(published);
  // Set when the project turned out to be gone already, or was deleted with a
  // cache warning: the dialog says so, and closing it removes the card.
  const [goneNotice, setGoneNotice] = useState<{ message: string; announcement: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const errorId = useId();

  // A fresh start every time the dialog opens.
  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
      setGoneNotice(null);
      setCurrentName(name);
      setNeedsName(published);
    }
  }, [open, name, published]);

  // What the person sees and types: an empty stored name reads as the
  // fallback, and typing the fallback confirms it.
  const shownName = currentName || FALLBACK_NAME;
  const confirmed = !needsName || (typed.length > 0 && typed === shownName);

  const run = async () => {
    if (!confirmed || deleting) return;
    setDeleting(true);
    setError(null);
    const result = await deleteProject(siteId, needsName ? currentName : undefined);
    setDeleting(false);
    if (result.ok) {
      onDeleted(`Deleted the project ${shownName}.`);
      return;
    }
    if (result.gone) {
      setGoneNotice({
        message: result.message,
        announcement: result.deletedWithWarning
          ? `Deleted the project ${shownName}.`
          : `The project ${shownName} is no longer in this company.`,
      });
      return;
    }
    if (result.currentName !== undefined) {
      // Refused confirmation: published and/or renamed since the page loaded.
      const renamed = result.currentName !== currentName;
      const nextShown = result.currentName || FALLBACK_NAME;
      setCurrentName(result.currentName);
      setNeedsName(true);
      setTyped('');
      setError(
        renamed
          ? `This project was renamed to "${nextShown}" in the meantime. Type the new name to confirm.`
          : `This project was published in the meantime, so it now needs its name typed to confirm.`,
      );
      window.setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    setError(result.message);
  };

  const finishGone = () => {
    if (goneNotice) onDeleted(goneNotice.announcement);
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Never close mid-request: the outcome must be seen.
        if (deleting) return;
        if (!next && goneNotice) {
          finishGone();
          return;
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(e) => {
          // Radix only auto-focuses its own Cancel part; place focus ourselves:
          // the name field when one is needed, else Cancel (the safe choice).
          e.preventDefault();
          (needsName ? inputRef.current : cancelRef.current)?.focus();
        }}
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
                  goes offline: visitors get a &ldquo;not found&rdquo; page.
                </p>
              ) : liveHost ? (
                <p>
                  Its address <span className="font-medium text-foreground">{liveHost}</span> is
                  released.
                </p>
              ) : null}
              {customDomains.length > 0 ? (
                <div>
                  <p>These custom domains are disconnected from it:</p>
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

        {/* The explanation above (with its list of custom domains, which can be
            long) is what scrolls in a short window: the shared alert dialog
            lets its header scroll. The confirmation and the buttons below
            never shrink, so they always stay on screen. */}
        {goneNotice ? (
          <div className="flex shrink-0 flex-col gap-4" data-testid="delete-project-actions">
            <p role="alert" className="text-[13px]">
              {goneNotice.message}
            </p>
            <AlertDialogFooter>
              <Button type="button" size="sm" onClick={finishGone}>
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
            className="flex shrink-0 flex-col gap-4"
            data-testid="delete-project-actions"
          >
            {needsName ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={inputId} className="text-[13px]">
                  Type <span className="font-semibold">{shownName}</span> to confirm
                </label>
                <input
                  ref={inputRef}
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
                ref={cancelRef}
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
