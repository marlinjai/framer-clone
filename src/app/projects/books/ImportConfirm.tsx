'use client';

// src/app/projects/books/ImportConfirm.tsx
//
// The confirmation the upload import asks before an action it cannot take
// back (raising the invoice counter, replacing what was typed, discarding a
// file): the shared alert dialog (components/ui/alert-dialog), so it keeps to
// the viewport like every dialog of the editor, traps the focus, starts on
// Cancel (the safe choice) and gives the focus back to what opened it.

import React from 'react';

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
  onConfirm: () => void;
  onCancel: () => void;
  /** Where the focus goes when it closes (default: back to what opened it). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
