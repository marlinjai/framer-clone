'use client';
// src/components/sidebars/right/sections/behaviourShared.tsx
//
// What the Page state panel and the Interactions section share: the page's trees as the
// parser reads them, the one write, and a control for a value of each state type. See
// "The panel" in docs/plans/2026-11-02-behaviour-model.md.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BehaviourNode, RefusedOnNode, StateValue } from '@/lib/behaviour/format';
import { getSnapshot } from 'mobx-state-tree';
import { isRecord, refusalAt, subtreeRefusals, sameStored, storedBehaviourOf, type Names, type StoredRecord } from '@/lib/behaviour/authoring';
import { FIELD_CONTROL, FIELD_LABEL, PropertySwitch } from '../primitives';
import { isComponentPlaceholderType } from '@/lib/components/placement';
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
export function SwitchRow({ label, name, hint, checked, onCheckedChange, locked }: {
  label: string;
  /** The switch's accessible name when the label alone repeats (one per action). Defaults to the label. */
  name?: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Focusable but taking no change, said with aria-disabled (a save is running). */
  locked?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1 pt-1.5">
        <span className={cn(FIELD_LABEL, 'leading-snug')}>{label}</span>
        <span className={HINT}>{hint}</span>
      </div>
      <PropertySwitch aria-label={name ?? label} aria-disabled={locked} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/**
 * Something focus can go to: a fixed selector, or a function that finds the control by
 * comparing attributes. Stored text (a value's name, an id from an import) is never put
 * into a selector, since a quote in it makes the selector invalid and `querySelector`
 * throw; `inStateRow` is how a value's row is found.
 */
export type FocusTarget = string | ((root: HTMLElement) => HTMLElement | null | undefined);

/** A control inside one value's row, the row found by comparing its id rather than through a selector. */
export const inStateRow = (stateId: string, selector: string): FocusTarget => (root) => {
  const row = Array.from(root.querySelectorAll<HTMLElement>('[data-state-id]')).find((el) => el.getAttribute('data-state-id') === stateId);
  return row?.querySelector<HTMLElement>(selector);
};

/**
 * Where keyboard focus goes after a write, and what is said about it. A control that a
 * write takes away (Add swapped for the editor, a deleted row, a closed editor) would
 * leave focus on the page body, so after the write the first of `targets` found inside
 * the section takes it. `message` is announced politely, since adding or deleting changes
 * the panel out of sight of a screen reader. The focus moves after the render the write
 * causes, so the control it looks for is there. A target that cannot be looked up (an
 * invalid selector, a function that throws) is passed over: moving the focus never takes
 * the editor down.
 */
export function useFocusAfter() {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{ targets: readonly FocusTarget[]; message?: string } | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!pending) return;
    const root = ref.current;
    for (const target of root ? pending.targets : []) {
      let found: HTMLElement | null | undefined = null;
      try {
        found = typeof target === 'string' ? root!.querySelector<HTMLElement>(target) : target(root!);
      } catch {
        found = null;
      }
      if (found) {
        found.focus();
        break;
      }
    }
    if (pending.message) setMessage(pending.message);
    setPending(null);
  }, [pending]);
  const request = useCallback((targets: readonly FocusTarget[], said?: string) => setPending({ targets, message: said }), []);
  const live = <p role="status" aria-live="polite" className="sr-only">{message}</p>;
  return { ref, request, live };
}

/**
 * True for a node that can hold behaviour: an element of its own, not a frame, a text run
 * or a placement (or what is left of one). A placement's behaviour is its definition's:
 * the expansion drops what its own props hold, so a value kept there would never be used.
 */
export const holdsBehaviour = (target: Pick<ComponentInstance, 'isViewportNode' | 'type'>): boolean =>
  !target.isViewportNode && target.type !== '#text' && !isComponentPlaceholderType(target.type);

/** What the page's trees, the page and its floating elements, need from a page. */
export interface BehaviourPage {
  expansion: { root: ComponentNode; floating: readonly ComponentNode[] };
  /** The page expanded with one stored subtree replaced, null when no node has its id (PageModel.expansionWith). */
  expansionWith(subtree: { id: string }): { root: ComponentNode; floating: readonly ComponentNode[] } | null;
  /** When the page is a definition's: each page placing it, expanded now and with `subtree` written (PageModel.placingExpansionsWith). */
  placingExpansionsWith(subtree: { id: string }): readonly {
    name: string;
    definition: string;
    before: { root: ComponentNode; floating: readonly ComponentNode[] };
    after: { root: ComponentNode; floating: readonly ComponentNode[] };
    findComponent(id: string): { displayName?: string } | undefined;
  }[];
  findComponent(id: string): ComponentInstance | undefined;
}

/** The trees the parser reads for this page: the page, then each floating element. */
export const rootsOf = (page: BehaviourPage): BehaviourNode[] => expansionRoots(page.expansion);

/** An expansion's trees as the parser reads them: the page, then each floating element. */
export const expansionRoots = (expansion: { root: ComponentNode; floating: readonly ComponentNode[] }): BehaviourNode[] =>
  [expansion.root, ...expansion.floating] as unknown as BehaviourNode[];

/** A name in a sentence, in quotes a quote inside the name cannot close. */
export const quoted = (raw: string): string => {
  // One line, and a closing typographic quote inside the name cannot close the quotes around it.
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name.includes('"')) return `"${name}"`;
  if (!name.includes("'")) return `'${name}'`;
  return `\u201c${name.replace(/\u201d/g, '"')}\u201d`;
};

/**
 * True when the definition itself stores the refused entry of a placement's root. The
 * expansion merges the placement's own Trigger field onto that root (`withPlacementBehaviour`
 * in expand.ts: its `on` after the definition's, its `showWhen` instead), and that field is
 * stored on the placing page, out of sight from the definition.
 */
function definitionStores(stored: StoredRecord | null, refusal: RefusedOnNode): boolean {
  if (refusal.entry === 'on') {
    const entry = stored && Array.isArray(stored.on) && refusal.index !== undefined ? stored.on[refusal.index] : undefined;
    return isRecord(entry) && isRecord(refusal.value) && entry.id === refusal.value.id;
  }
  if (refusal.entry === 'showWhen') return stored?.showWhen !== undefined && sameStored(stored.showWhen, refusal.value);
  return true;
}

/** The nodes from a root of an expansion's trees down to the node with this id, or empty. */
function pathTo(roots: readonly ComponentNode[], id: string): ComponentNode[] {
  for (const root of roots) {
    if (root.id === id) return [root];
    const below = pathTo(root.children ?? [], id);
    if (below.length > 0) return [root, ...below];
  }
  return [];
}

/**
 * Why writing `subtree` would make the parser refuse something new on a page that places
 * the definition open on the canvas, or null. A definition's behaviour counts on every
 * page that places it (the 64 KB cap above all), so an edit inside one is judged there
 * too, naming the element and the page it would stop. Null on an ordinary page.
 *
 * With `current` (the subtree as stored now), a removal's refusals are split as on the
 * definition's own page (subtreeRefusals). A reference to a removed node from inside a
 * placement of the definition is the same reader the definition's own page asks about
 * (and the person may confirm), so it is let through here. One from outside the
 * placement (a trigger on the placing page itself) is out of sight, and is refused.
 */
export function placingRefusal(page: BehaviourPage, subtree: { id: string }, current?: { id: string }): string | null {
  // A reader named by a node of the page it is on (the one a person opens to fix it) wins
  // over one named only through a placement, so a reader stored in an outer definition is
  // named on that definition rather than on the first page placing it.
  let indirect: string | null = null;
  for (const placing of page.placingExpansionsWith(subtree)) {
    const before = expansionRoots(placing.before);
    const after = expansionRoots(placing.after);
    const { refused, dangling } = subtreeRefusals(before, after, (current ?? subtree) as unknown as BehaviourNode, subtree as unknown as BehaviourNode);
    // An expanded node keeps its id in the definition as classKey: found there, it is inside a placement.
    const reader = (refusal: RefusedOnNode) => {
      const path = refusal.nodeId ? pathTo([placing.after.root, ...placing.after.floating], refusal.nodeId) : [];
      const node = path.at(-1);
      const key = node?.classKey;
      // A node the edit adds is not stored yet: it is named as part of the element being edited.
      const found = key === undefined ? undefined
        : page.findComponent(key) ?? (pathTo([subtree as ComponentNode], key).length > 0 ? page.findComponent(subtree.id) : undefined);
      const inner = found && (!node?.placementRoot || definitionStores(storedBehaviourOf(found.props), refusal)) ? found : undefined;
      if (inner) return { inside: true, direct: true, name: `${quoted(inner.displayName ?? 'an element')} in ${quoted(placing.definition)}` };
      const own = refusal.nodeId ? placing.findComponent(refusal.nodeId)?.displayName : undefined;
      if (own) return { inside: false, direct: true, name: quoted(own) };
      // Inside another component's placement: named by the nearest placement the page holds.
      const around = path.slice(0, -1).reverse().map((above) => placing.findComponent(above.id ?? '')?.displayName).find(Boolean);
      return { inside: false, direct: false, name: around ? `an element in ${quoted(around)}` : 'an element' };
    };
    const hard = refused[0];
    const hit = hard ? reader(hard) : dangling.map(reader).find((found) => !found.inside);
    if (!hit) continue;
    const message = `it would stop ${hit.name} working on ${quoted(placing.name)}: ${hard ? hard.reason : 'it names something this removes'}`;
    if (hit.direct) return message;
    indirect ??= message;
  }
  return indirect;
}

/**
 * The one check before a node's behaviour is written: the page it is on (refusalAt, the
 * whole page read before and after), then, inside a definition, every page placing it.
 */
export function behaviourRefusal(
  page: BehaviourPage,
  component: ComponentInstance,
  behaviour: StoredRecord,
  written?: unknown,
  nameOf?: (id: string) => string,
): string | null {
  const here = refusalAt(rootsOf(page), component.id, behaviour, written, nameOf);
  if (here) return here;
  const snapshot = getSnapshot(component) as unknown as StoredRecord & { id: string };
  const props = isRecord(snapshot.props) ? snapshot.props : {};
  const next: StoredRecord & { id: string } = { ...snapshot, props: { ...props, behaviour } };
  return placingRefusal(page, next);
}

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
 * a number does not write a step per character. Text that is not a number, typed into a
 * number's field, is said so under the field and written nowhere.
 */
export function ValueControl({ state, value, onChange, 'aria-label': label, disabled, allowFirst }: ValueControlProps) {
  const [notNumber, setNotNumber] = useState<string | null>(null);
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
  return (
    <>
      <CommitField aria-label={label} disabled={disabled} numeric={type === 'number'} invalid={notNumber !== null} value={valueText(value)} allowEmpty={allowFirst} onEdit={() => setNotNumber(null)} onCommit={(text) => {
        setNotNumber(null);
        if (text === '' && allowFirst) return onChange(undefined);
        if (type === 'number') {
          const number = Number(text);
          if (text.trim() !== '' && Number.isFinite(number)) onChange(number);
          else setNotNumber(`${text.trim() || 'An empty field'} is not a number`);
          return;
        }
        onChange(text);
      }} />
      {notNumber && <span role="alert" className={REASON}>{`Not changed: ${notNumber}.`}</span>}
    </>
  );
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
  /** Called when the text is changed or put back, so a message about the last commit can go. */
  onEdit?: () => void;
}

/** A text field that keeps what is typed and hands it over on Enter or blur; Escape puts back what is stored. */
export function CommitField({ value, onCommit, 'aria-label': label, numeric, disabled, placeholder, invalid, onEdit }: CommitFieldProps) {
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
      onChange={(event) => {
        setDraft(event.target.value);
        onEdit?.();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') {
          setDraft(value);
          onEdit?.();
        }
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
