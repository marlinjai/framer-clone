'use client';

// src/app/projects/catalog/ui.tsx
//
// Small shared pieces of the catalogue area, in the Books' glass language
// (globals.css: glass-ground, glass, glass-inset): the status pill (a dot and
// the word, so colour never carries it alone), a product thumbnail, the error
// alert every screen uses with the server's sentence, a select and a text
// field that save when they are left, and the error text of anything a call
// can throw.

import { ImageIcon } from 'lucide-react';
import React, { useEffect, useId, useRef, useState } from 'react';

import { CatalogApiError, imageUrl } from '@/lib/catalog/api';
import { STATUS_LABELS, type ImageRef, type ProductStatus } from '@/lib/catalog/types';
import { cn } from '@/lib/utils';

export const INPUT =
  'h-9 w-full rounded-lg border border-foreground/10 bg-background/70 px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 aria-invalid:border-destructive disabled:opacity-60';

const STATUS_DOTS: Record<ProductStatus, string> = {
  draft: 'bg-status-draft',
  published: 'bg-status-published',
  archived: 'bg-muted-foreground',
};

export function StatusPill({ status }: { status: ProductStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-xs font-medium text-foreground">
      <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_DOTS[status])} />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** A square thumbnail of a stored image, or a quiet placeholder. */
export function Thumb({ image, size = 40, alt = '' }: { image: ImageRef | null; size?: number; alt?: string }) {
  return (
    <span
      className="glass-inset flex shrink-0 items-center justify-center overflow-hidden rounded-lg"
      style={{ width: size, height: size }}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a private, session-guarded image route; next/image would proxy it
        <img src={imageUrl(image.sha256)} alt={alt} width={size} height={size} loading="lazy" className="size-full object-cover" />
      ) : (
        <ImageIcon aria-hidden className="size-4 text-muted-foreground/60" />
      )}
    </span>
  );
}

export function ErrorAlert({ message, onDismiss, onRetry }: { message: string | null; onDismiss?: () => void; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-4 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive"
    >
      <span>{message}</span>
      <span className="flex shrink-0 gap-3">
        {onRetry ? (
          <button type="button" onClick={onRetry} className="underline underline-offset-4">
            Try again
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" onClick={onDismiss} className="underline underline-offset-4">
            Dismiss
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** The error text of anything a catalogue call can throw. */
export function errorText(err: unknown): string {
  if (err instanceof CatalogApiError) {
    const issues = err.details.issues as Array<{ path: string; message: string }> | undefined;
    if (issues && issues.length > 1) return `${err.message}: ${issues.map((i) => `${i.path} (${i.message})`).join(', ')}`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong. Try again.';
}

/**
 * A labelled text field that saves when it is left or Enter is pressed (Escape
 * puts the stored value back), as the invoice editor's fields do. `parse` turns
 * the typed text into the value to save, or a sentence saying what is wrong.
 */
export function SaveField<T>({
  label,
  value,
  format,
  parse,
  onSave,
  hint,
  multiline,
  placeholder,
  inputMode,
  disabled,
  maxLength,
  list,
  className,
}: {
  label: string;
  value: T;
  format: (v: T) => string;
  parse: (text: string) => { ok: true; value: T } | { ok: false; message: string };
  onSave: (v: T) => Promise<void>;
  hint?: string;
  multiline?: boolean;
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  disabled?: boolean;
  maxLength?: number;
  /** The id of a datalist of suggestions. */
  list?: string;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState(format(value));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);
  const stored = format(value);
  // The stored value moves (a save, an undo, a reload): show it unless the person is typing.
  useEffect(() => {
    if (!editing.current) setText(stored);
  }, [stored]);

  async function commit() {
    editing.current = false;
    if (text === stored) {
      setError(null);
      return;
    }
    const parsed = parse(text);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.value);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  const common = {
    id,
    value: text,
    disabled: disabled || saving,
    placeholder,
    maxLength,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      editing.current = true;
      setText(e.target.value);
    },
    onBlur: () => void commit(),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        editing.current = false;
        setText(stored);
        setError(null);
      } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void commit();
      }
    },
  };
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {multiline ? (
        <textarea {...common} rows={3} className={cn(INPUT, 'h-auto min-h-20 py-2')} />
      ) : (
        <input {...common} inputMode={inputMode} list={list} className={INPUT} />
      )}
      {hint ? (
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A labelled select that saves on change; a refused save shows the server's sentence and the stored value again. */
export function SaveSelect<T extends string>({
  label,
  value,
  options,
  onSave,
  hint,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onSave: (v: T) => Promise<void>;
  hint?: string;
  className?: string;
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={saving}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={async (e) => {
          const next = e.target.value as T;
          setSaving(true);
          setError(null);
          try {
            await onSave(next);
          } catch (err) {
            setError(errorText(err));
          } finally {
            setSaving(false);
          }
        }}
        className={INPUT}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && !error ? (
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A panel section with its heading (the panel's sections are landmarks a screen reader can jump between). */
export function Section({ title, id, children, aside }: { title: string; id: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="glass rounded-2xl p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id={id} className="text-sm font-semibold tracking-tight">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}
