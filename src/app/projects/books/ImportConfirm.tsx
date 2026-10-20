'use client';

// src/app/projects/books/ImportConfirm.tsx
//
// The confirmation the upload import asks before an action it cannot take
// back (raising the invoice counter, replacing what was typed, discarding a
// file): the shared alert dialog (components/ui/alert-dialog), so it keeps to
// the viewport like every dialog of the editor, traps the focus, starts on
// Cancel (the safe choice) and gives the focus back to what opened it.
//
// Confirming is never also a cancel: the owner closes the dialog through its
// own state when it has acted, so a question that changed meanwhile (a new
// number to confirm) stays open with the new question instead of closing.

import React, { useRef } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export default function ImportConfirm({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  onCloseAutoFocus,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** Acts, and closes the dialog through the owner's state (or keeps it open with a new question). */
  onConfirm: () => void;
  onCancel: () => void;
  /** Where the focus goes when it closes (default: back to what opened it). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const confirmed = useRef(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (confirmed.current) {
          confirmed.current = false;
          return;
        }
        onCancel();
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              confirmed.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
