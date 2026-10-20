'use client';

// src/app/projects/books/ui.tsx
//
// Small shared pieces of the Books area: the error alert every screen uses (so
// a failure is always shown with the server's sentence, never swallowed), a
// status badge and a labelled field.

import React from 'react';

import { STATUS_LABELS, type DocumentView } from '@/lib/books/api';

export function ErrorAlert({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex items-start justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      <span>{message}</span>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="shrink-0 underline underline-offset-4">
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

const STATUS_STYLES: Record<DocumentView['status'], string> = {
  draft: 'border-dashed text-muted-foreground',
  issued: 'border-foreground/30 text-foreground',
  sent: 'border-foreground/30 text-foreground',
  accepted: 'border-foreground/30 text-foreground',
  rejected: 'text-muted-foreground',
  paid: 'border-foreground/30 text-foreground',
  cancelled: 'text-muted-foreground line-through',
};

export function StatusBadge({ status }: { status: DocumentView['status'] }) {
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** The error text of anything a Books call can throw. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Try again.';
}

/** The marker of a historical invoice brought in by `pnpm books:import`. */
export function ImportedBadge() {
  return (
    <span
      className="shrink-0 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground"
      title="Imported from the earlier invoices: the original PDF is the document of record"
    >
      Imported
    </span>
  );
}
