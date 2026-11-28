'use client';
// src/app/projects/UnpublishProjectDialog.tsx
//
// The confirmation for taking a published site offline (dashboard card menu,
// "Unpublish"). It names the addresses that stop working and says what is kept.
// The dialog stays open on failure with the reason, because an unfinished
// unpublish is retried from here, and one request runs at a time. Focus starts
// on Cancel, the safe choice.

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { unpublishProject } from '@/lib/projects/unpublishProject';

export interface UnpublishProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  name: string;
  /** `<label>.sites.lumitra.co` once the project has a published address. */
  liveHost: string | null;
  customDomains: string[];
  /**
   * Called after every request, so the list shows the server's state: with an
   * announcement when the site went offline, with null when it did not finish.
   */
  onSettled: (announcement: string | null) => void;
  /** Where keyboard focus goes when the dialog closes. */
  returnFocusTo: () => HTMLElement | null;
}

export default function UnpublishProjectDialog({
  open,
  onOpenChange,
  siteId,
  name,
  liveHost,
  customDomains,
  onSettled,
  returnFocusTo,
}: UnpublishProjectDialogProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // A fresh start every time the dialog opens.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const run = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    const result = await unpublishProject(siteId);
    setWorking(false);
    if (result.ok) {
      onSettled(`The site ${name} is offline.`);
      onOpenChange(false);
      return;
    }
    setError(result.message);
    onSettled(null);
  };

  const addresses = [...(liveHost ? [liveHost] : []), ...customDomains];

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Never close mid-request: the outcome must be seen.
        if (!working) onOpenChange(next);
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
        onEscapeKeyDown={(e) => {
          if (working) e.preventDefault();
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
          <AlertDialogTitle>Unpublish &ldquo;{name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>The site goes offline: visitors get a &ldquo;not found&rdquo; page.</p>
              {addresses.length > 0 ? (
                <ul className="list-disc pl-5">
                  {addresses.map((address) => (
                    <li key={address} className="font-medium text-foreground">
                      {address}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p>The project, its published versions, the address and the domains are kept. You can publish again.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex shrink-0 flex-col gap-4">
          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button
              ref={cancelRef}
              type="button"
              variant="outline"
              size="sm"
              disabled={working}
              onClick={() => onOpenChange(false)}
            >
              {error ? 'Close' : 'Cancel'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={working}
              aria-busy={working || undefined}
              onClick={() => void run()}
            >
              {working ? 'Unpublishing…' : error ? 'Try again' : 'Unpublish site'}
            </Button>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
// ci-replay touch
