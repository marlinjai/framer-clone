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

/** Each status as a coloured dot (the app's status tokens) beside readable text: the colour never carries it alone. */
const STATUS_DOTS: Record<DocumentView['status'], string> = {
  draft: 'bg-status-draft',
  issued: 'bg-status-published',
  sent: 'bg-status-scheduled',
  accepted: 'bg-status-published',
  rejected: 'bg-muted-foreground',
  paid: 'bg-status-published',
  cancelled: 'bg-destructive',
};

export function StatusBadge({ status }: { status: DocumentView['status'] }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      <span aria-hidden className={`size-1.5 rounded-full ${STATUS_DOTS[status]}`} />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? (
        <span id={fieldHintId(htmlFor)} className="text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={fieldErrorId(htmlFor)} className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export const fieldHintId = (id: string) => `${id}-hint`;
export const fieldErrorId = (id: string) => `${id}-error`;

/** The accessibility attributes of a {@link Field}'s control. */
export function fieldA11y(id: string, opts: { error?: string | null; hint?: boolean }) {
  const described = [opts.hint ? fieldHintId(id) : null, opts.error ? fieldErrorId(id) : null].filter(Boolean);
  return {
    id,
    'aria-invalid': opts.error ? true : undefined,
    'aria-describedby': described.length > 0 ? described.join(' ') : undefined,
  };
}

/** A timestamp's calendar day where the user is (a save after midnight in Germany is on the German date); '' when unreadable. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** The error text of anything a Books call can throw. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Try again.';
}

/** The marker of a historical invoice brought in by `pnpm books:import`. */
export function ImportedBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      title="Imported from the earlier invoices: the original PDF is the document of record"
    >
      Imported
    </span>
  );
}
