'use client';
// src/components/sidebars/right/sections/behaviourShared.tsx
//
// What the Page state panel and the Interactions section share: the page's trees as the
// parser reads them, the one write, and a control for a value of each state type. See
// "The panel" in docs/plans/2026-11-02-behaviour-model.md.

import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BehaviourNode, StateValue } from '@/lib/behaviour/format';
import { isRecord, sameStored, storedBehaviourOf, type Names, type StoredRecord } from '@/lib/behaviour/authoring';
import { FIELD_CONTROL, FIELD_LABEL, PropertySwitch } from '../primitives';
import { cn } from '@/lib/utils';

export const HINT = 'text-[11px] leading-snug text-muted-foreground';
export const REASON = 'text-[11px] leading-snug text-destructive';
export const SMALL_BUTTON =
  'inline-flex h-7 items-center justify-center rounded-[6px] border border-border px-2 text-[11px] text-foreground '
  + 'transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand '
  + 'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * A switch with a label too long for a PropertyRow's 64 pixel label column, which cut
 * "Stop the browser's own response" to "Stop the b...". The label takes the width and
 * wraps, the hint is shown under it rather than only on hover, and the label names the
 * switch for assistive technology.
 */
export function SwitchRow({ label, name, hint, checked, onCheckedChange }: {
  label: string;
  /** The switch's accessible name when the label alone repeats (one per action). Defaults to the label. */
  name?: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1 pt-1.5">
        <span className={cn(FIELD_LABEL, 'leading-snug')}>{label}</span>
        <span className={HINT}>{hint}</span>
      </div>
      <PropertySwitch aria-label={name ?? label} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** What the page's trees, the page and its floating elements, need from a page. */
export interface BehaviourPage {
  expansion: { root: ComponentNode; floating: readonly ComponentNode[] };
  findComponent(id: string): ComponentInstance | undefined;
}

/** The trees the parser reads for this page: the page, then each floating element. */
export const rootsOf = (page: BehaviourPage): BehaviourNode[] =>
  [page.expansion.root, ...page.expansion.floating] as unknown as BehaviourNode[];

/** How ids read in a sentence: a value by its name, an element by its layer name. */
export function namesFor(page: BehaviourPage, states: readonly StateValue[]): Names {
  return {
    state: (id) => states.find((state) => state.id === id)?.name ?? `a value that is gone (${id})`,
    node: (id) => page.findComponent(id)?.displayName ?? `an element that is gone (${id})`,
  };
}

/**
 * Writes a node's behaviour as one undo step, and writes nothing when the value is what
 * is already stored, so committing a field unchanged adds no step to the history.
 */
export function writeBehaviour(component: ComponentInstance, next: StoredRecord | undefined): boolean {
  const current = storedBehaviourOf(component.props);
  if (current !== null && next !== undefined && sameStored(current, next)) return false;
  if (current !== null && next === undefined && Object.keys(current).length === 0) return false;
  const result = component.setBehaviour(next);
  return result.ok;
}

/** The value a state's first value or preview control shows, as text for a native field. */
export const valueText = (value: unknown): string => (value === undefined ? '' : String(value));

interface ValueControlProps {
  state: StoredRecord;
  value: unknown;
  /** Called with a value of the state's type, or undefined for "First value" when `allowFirst`. */
  onChange: (value: string | number | boolean | undefined) => void;
  'aria-label': string;
  disabled?: boolean;
  /** Offers "First value" first, for the preview. */
  allowFirst?: boolean;
}

/**
 * A control for one value of a state's type: a select for on or off and for a choice,
 * a number field, a text field. Fields commit on Enter or when focus leaves, so typing
 * a number does not write a step per character.
 */
export function ValueControl({ state, value, onChange, 'aria-label': label, disabled, allowFirst }: ValueControlProps) {
  const type = state.type;
  if (type === 'boolean' || type === 'choice') {
    const options = type === 'boolean'
      ? [{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]
      : (Array.isArray(state.options) ? state.options : []).map((option) => ({ value: String(option), label: String(option) }));
    return (
      <select
        aria-label={label}
        disabled={disabled}
        value={value === undefined ? '' : String(value)}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === '') onChange(undefined);
          else onChange(type === 'boolean' ? raw === 'true' : raw);
        }}
        className={cn(FIELD_CONTROL, 'cursor-pointer')}
      >
        {allowFirst && <option value="">First value</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  return <CommitField aria-label={label} disabled={disabled} numeric={type === 'number'} value={valueText(value)} allowEmpty={allowFirst} onCommit={(text) => {
    if (text === '' && allowFirst) return onChange(undefined);
    if (type === 'number') {
      const number = Number(text);
      if (text.trim() !== '' && Number.isFinite(number)) onChange(number);
      return;
    }
    onChange(text);
  }} />;
}

interface CommitFieldProps {
  value: string;
  onCommit: (text: string) => void;
  'aria-label': string;
  numeric?: boolean;
  disabled?: boolean;
  placeholder?: string;
  allowEmpty?: boolean;
  invalid?: boolean;
}

/** A text field that keeps what is typed and hands it over on Enter or blur; Escape puts back what is stored. */
export function CommitField({ value, onCommit, 'aria-label': label, numeric, disabled, placeholder, invalid }: CommitFieldProps) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      type="text"
      inputMode={numeric ? 'decimal' : undefined}
      aria-label={label}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') setDraft(value);
      }}
      onBlur={commit}
      className={cn(FIELD_CONTROL, numeric && 'tabular-nums')}
    />
  );
}

/**
 * The whole stored value as text, for telling two stored entries apart: an edit an
 * error belongs to, or whether an open editor's entry changed underneath it. Never
 * shortened, since two triggers can differ only past any length.
 */
export const storedText = (value: unknown): string => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
};

export const recordOr = (value: unknown): StoredRecord => (isRecord(value) ? value : {});
