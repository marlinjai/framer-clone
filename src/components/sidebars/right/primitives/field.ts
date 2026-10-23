'use client';
// Shared inspector field spec. Every control in the right panel is built from
// these classes so the panel has one field height (28px), one radius (6px),
// one value size (12px) and one label size (11px).
import { createContext, useContext, useId } from 'react';

/** Bordered shell of a field. Focus styling lives on the shell (focus-within). */
export const FIELD_SHELL =
  'h-7 w-full min-w-0 rounded-[6px] border border-border bg-background text-foreground transition-colors ' +
  'focus-within:border-brand focus-within:ring-3 focus-within:ring-brand/12';

/** A native input or select that IS the field (no inner parts). */
export const FIELD_CONTROL =
  'h-7 w-full min-w-0 rounded-[6px] border border-border bg-background px-2 text-[12px] text-foreground ' +
  'outline-none transition-colors placeholder:text-muted-foreground/70 ' +
  'focus:border-brand focus:ring-3 focus:ring-brand/12';

/** A borderless input that sits inside a FIELD_SHELL. */
export const FIELD_INNER_INPUT =
  'h-full w-full min-w-0 flex-1 bg-transparent px-2 text-[12px] text-foreground outline-none ' +
  'placeholder:text-muted-foreground/70 disabled:cursor-not-allowed';

/** Label text: 11px muted. */
export const FIELD_LABEL = 'text-[11px] leading-none text-muted-foreground';

/**
 * Set by PropertyRow so the control inside it can take the row label as its
 * accessible name: `id` goes on the primary control (the row renders
 * `<label htmlFor={id}>`), `label` is used for secondary controls such as a
 * unit picker ("Gap unit").
 */
export interface FieldContextValue {
  id: string;
  label: string;
}

export const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

/**
 * Resolve how a control is named, in order of precedence:
 *   1. its own visible `label` (the control renders `<label htmlFor={id}>`),
 *   2. an explicit `ariaLabel` (two-up fields such as W / H inside one row),
 *   3. the surrounding PropertyRow label (the row renders the `<label>`).
 * `name` is the plain-text name, used to label secondary controls.
 */
export function useFieldIdentity(label: string | undefined, ariaLabel: string | undefined) {
  const ownId = useId();
  const ctx = useFieldContext();
  if (label) return { id: ownId, ariaLabel: undefined, name: label, showLabel: true };
  if (ariaLabel || !ctx) return { id: ownId, ariaLabel, name: ariaLabel ?? '', showLabel: false };
  return { id: ctx.id, ariaLabel: undefined, name: ctx.label, showLabel: false };
}
