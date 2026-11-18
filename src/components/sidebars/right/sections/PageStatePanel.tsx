'use client';
// src/components/sidebars/right/sections/PageStatePanel.tsx
//
// The Page state panel (docs/plans/2026-11-02-behaviour-model.md, "The panel", slice B11):
// the page root's values, then the values of each scope above the selected node, under
// that node's name. Each row holds a name, a type, a first value and a preview control.
// "Add value" puts a value on the page; "Keep per row" puts it on the selected element,
// so each row of a list, or each copy of a component, keeps its own.
//
// Every edit goes through the parser before it is written, the value on its own
// (`stateRefusal`) and then the whole page (`refusalAt`), so a value that would push the
// page past its size cap, or break what reads it elsewhere, is refused with the parser's
// reason. Each edit is one undo step. The preview is the canvas's (EditorUIStore.previewState): volatile, never
// saved, never in undo, and off in Interact, where the page runs from its first values.
// A value that no longer fits its state after an edit (an option removed, a type
// changed) is taken out of the preview, not just hidden.

import React, { useContext, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Variable, Plus, Trash2 } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { useStore } from '@/hooks/useStore';
import { fitsState } from '@/lib/behaviour/surfaceBehaviour';
import {
  STATE_TYPES,
  freshStateId,
  freshStateName,
  holdsNonList,
  isRecord,
  isStateType,
  newState,
  optionsFromText,
  pathTo,
  putEntry,
  readersOf,
  refusalAt,
  refusalsOn,
  removeEntry,
  retype,
  stateNameRefusal,
  stateRefusal,
  storedBehaviourOf,
  storedList,
  type StoredRecord,
} from '@/lib/behaviour/authoring';
import { CollapsibleSection, FIELD_CONTROL, FIELD_LABEL } from '../primitives';
import { CommitField, HINT, REASON, SMALL_BUTTON, ValueControl, holdsBehaviour, inStateRow, storedText, rootsOf, useFocusAfter, valueText, writeBehaviour, type BehaviourPage, type FocusTarget } from './behaviourShared';
import { cn } from '@/lib/utils';

interface PageStatePanelProps {
  /** The selected element, whose scopes are listed under the page's own values. */
  component?: ComponentInstance;
}

/** True when the node sits inside a Collection, so a value kept on it is kept once per row. */
function insideCollection(path: readonly { props?: unknown }[]): boolean {
  return path.slice(0, -1).some((node) => isRecord(node.props) && node.props['data-component-kind'] === 'collection');
}

export const PageStatePanel = observer(({ component }: PageStatePanelProps) => {
  const { editorUI } = useStore();
  const [addError, setAddError] = useState<string | null>(null);
  const focus = useFocusAfter();
  const page = editorUI.currentPage as unknown as (BehaviourPage & { appComponentTree: ComponentInstance }) | undefined;
  if (!page) return null;
  const root = page.appComponentTree;
  const roots = rootsOf(page);
  // A frame, a text run and a placement hold no values of their own (holdsBehaviour), so
  // nothing is kept on one; the scopes above a placement are still listed.
  const selected = component && !component.isViewportNode && component.type !== '#text' ? component : undefined;
  const found = selected ? pathTo(roots, selected.id) : null;

  // The page root first, then every scope on the way down that holds stored state.
  const scopes: ComponentInstance[] = [root];
  for (const node of found?.path ?? []) {
    if (typeof node.id !== 'string' || node.id === root.id) continue;
    const live = page.findComponent(node.id);
    if (!live || !holdsBehaviour(live)) continue;
    const stored = storedBehaviourOf(live.props);
    if (stored !== null && (storedList(stored, 'state').length > 0 || holdsNonList(stored, 'state'))) scopes.push(live);
  }
  // Offered whenever the element can take another value, also when it already keeps some,
  // so a card can keep both "expanded" and "liked".
  const selectedStored = selected ? storedBehaviourOf(selected.props) : null;
  const canKeepHere = selected && holdsBehaviour(selected) && selected.id !== root.id && found !== null
    && selectedStored !== null && !holdsNonList(selectedStored, 'state');
  const keepLabel = found && insideCollection(found.path) ? 'Keep per row' : 'Keep on this element';

  const add = (on: ComponentInstance) => {
    const stored = storedBehaviourOf(on.props);
    if (stored === null || holdsNonList(stored, 'state')) return;
    // A name no value of the page holds, so the page's "Value 1" and a card's never read as one.
    const state = newState(freshStateId(roots), freshStateName(roots), 'boolean');
    const next = putEntry(stored, 'state', state);
    const reason = refusalAt(roots, on.id, next, state, nameIn(page));
    setAddError(reason);
    if (reason) return;
    writeBehaviour(on, next);
    focus.request([inStateRow(state.id, NAME_FIELD)], `Added ${state.name}`);
  };

  return (
    <FocusRequest.Provider value={focus.request}>
    <div data-testid="page-state-panel" ref={focus.ref}>
      <CollapsibleSection title="Page state" icon={<Variable size={14} />} normalOnly>
        {scopes.map((scope) => (
          <ScopeStates key={scope.id} scope={scope} page={page} title={scope === root ? 'This page' : scope.displayName} />
        ))}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" data-add-value="" className={SMALL_BUTTON} onClick={() => add(root)} aria-label="Add a value to the page">
            <Plus size={12} aria-hidden className="mr-1" /> Add value
          </button>
          {canKeepHere && selected && (
            <button type="button" className={SMALL_BUTTON} onClick={() => add(selected)} aria-label={`${keepLabel}: add a value to ${selected.displayName}`}>
              <Plus size={12} aria-hidden className="mr-1" /> {keepLabel}
            </button>
          )}
        </div>
        {addError && <p role="alert" className={REASON}>Not added: {addError}.</p>}
      </CollapsibleSection>
      {focus.live}
    </div>
    </FocusRequest.Provider>
  );
});

PageStatePanel.displayName = 'PageStatePanel';

/** Where focus goes after a row's write, handed down from the panel (useFocusAfter). */
const FocusRequest = React.createContext<(targets: readonly FocusTarget[], said?: string) => void>(() => {});

/** A row's name field and its delete button, as fixed selectors inside the row. */
const NAME_FIELD = 'input[aria-label^="Name of"]';
const ROW_DELETE = 'button[data-delete-value]';

/** An element as a refusal names it: its layer name. */
const nameIn = (page: BehaviourPage) => (id: string): string => `"${page.findComponent(id)?.displayName ?? id}"`;

const ScopeStates = observer(({ scope, page, title }: { scope: ComponentInstance; page: BehaviourPage; title: string }) => {
  const stored = storedBehaviourOf(scope.props);
  const refused = refusalsOn(rootsOf(page), scope.id);
  if (stored === null || holdsNonList(stored, 'state')) {
    const reason = refused.find((entry) => entry.entry === 'behaviour' || entry.entry === 'state')?.reason ?? 'this behaviour cannot be read';
    return (
      <div className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL}>{title}</span>
        <p className={REASON}>Its values are not used: {reason}.</p>
        <button type="button" className={SMALL_BUTTON} onClick={() => writeBehaviour(scope, stored === null ? undefined : { ...stored, state: [] })}>
          Remove what cannot be read
        </button>
      </div>
    );
  }
  const list = storedList(stored, 'state');
  // The page's caps refuse a node's behaviour whole: then none of its values is in reach.
  const whole = refused.find((entry) => entry.entry === 'behaviour')?.reason;
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={`Values of ${title}`}>
      <span className={FIELD_LABEL}>{title}</span>
      {whole && <p className={REASON}>None of these values is used: {whole}.</p>}
      {list.length === 0 && <p className={HINT}>No values yet. A value is what an interaction sets and a Show when reads.</p>}
      {list.map((entry, index) => {
        const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : `#${index}`;
        const reason = refused.find((r) => r.entry === 'state' && r.index === index)?.reason;
        return <StateRow key={`${scope.id}:${id}:${index}`} scope={scope} page={page} stored={stored} entry={entry} index={index} reason={reason} />;
      })}
    </div>
  );
});

ScopeStates.displayName = 'ScopeStates';

interface StateRowProps {
  scope: ComponentInstance;
  page: BehaviourPage;
  stored: StoredRecord;
  entry: unknown;
  index: number;
  /** Why the parser refuses this stored value, when it does. */
  reason?: string;
}

const StateRow = observer(({ scope, page, stored, entry, index, reason }: StateRowProps) => {
  const { editorUI } = useStore();
  const requestFocus = useContext(FocusRequest);
  // A refusal of what a person just entered, shown until the stored value changes.
  const [error, setError] = useState<{ reason: string; for: string } | null>(null);
  // A type picked but not yet applied, and a delete waiting for its confirmation: a select's
  // change (an arrow key in some browsers) never retypes, and a value something reads is
  // never deleted on one press.
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const storedKey = storedText(entry);
  const shownError = error && error.for === storedKey ? error.reason : null;

  if (!isRecord(entry)) {
    return (
      <div className="flex items-start justify-between gap-2">
        <p className={REASON}>An entry that is not a value: {reason ?? 'a state value is an object'}.</p>
        <DeleteButton label={`Delete the entry ${index + 1} that is not a value`} onClick={() => writeBehaviour(scope, removeEntry(stored, 'state', index))} />
      </div>
    );
  }

  const id = typeof entry.id === 'string' ? entry.id : '';
  const name = typeof entry.name === 'string' && entry.name ? entry.name : `Value ${index + 1}`;
  const preset = entry.preset === true;

  /** Writes one change through the parser; a refusal is shown and nothing is written. True when written. */
  const commit = (next: StoredRecord): boolean => {
    const behaviour = putEntry(stored, 'state', next, index);
    const refusal = stateRefusal(next) ?? refusalAt(rootsOf(page), scope.id, behaviour, next, nameIn(page));
    if (refusal) {
      setError({ reason: refusal, for: storedKey });
      return false;
    }
    setError(null);
    writeBehaviour(scope, behaviour);
    // A preview this value can no longer hold goes, rather than hiding behind the first value.
    const previewed = editorUI.previewState[id];
    if (previewed !== undefined && !fitsState(next, previewed)) editorUI.setPreviewValue(id, undefined);
    return true;
  };

  const readers = id ? readersOf(rootsOf(page), id) : [];
  const readerNames = readers.map((reader) => page.findComponent(reader)?.displayName ?? reader);

  const remove = () => {
    setConfirmDelete(false);
    // Focus goes to the next value, or the one before, or Add value, since this row is gone.
    const list = storedList(stored, 'state');
    const near = [list[index + 1], list[index - 1]]
      .map((other) => (isRecord(other) && typeof other.id === 'string' ? inStateRow(other.id, NAME_FIELD) : null))
      .filter((target): target is FocusTarget => target !== null);
    writeBehaviour(scope, removeEntry(stored, 'state', index));
    requestFocus([...near, '[data-add-value]'], `Deleted ${name}`);
    if (editorUI.previewState[id] !== undefined) editorUI.setPreviewValue(id, undefined);
  };

  const preview = editorUI.previewState[id];
  const interact = editorUI.interactOn;
  const numberField = (field: 'min' | 'max' | 'step') => (
    <CommitField
      aria-label={`${field === 'min' ? 'Lowest' : field === 'max' ? 'Highest' : 'Step'} of ${name}`}
      numeric
      placeholder={field === 'step' ? '1' : 'none'}
      disabled={preset}
      value={valueText(entry[field])}
      onCommit={(text) => {
        if (text.trim() === '') {
          const next = { ...entry };
          delete next[field];
          return commit(next);
        }
        const number = Number(text);
        if (!Number.isFinite(number)) return setError({ reason: `${text} is not a number`, for: storedKey });
        commit({ ...entry, [field]: number });
      }}
    />
  );

  return (
    <div className="flex flex-col gap-1.5 rounded-[6px] border border-border p-2" data-state-id={id}>
      <div className="flex items-center gap-1.5">
        <CommitField aria-label={`Name of ${name}`} value={typeof entry.name === 'string' ? entry.name : ''} onCommit={(text) => {
          const taken = stateNameRefusal(rootsOf(page), id, text);
          if (taken) return setError({ reason: taken, for: storedKey });
          commit({ ...entry, name: text.trim() });
        }} />
        {!preset && <DeleteButton row label={`Delete ${name}`} onClick={() => (readers.length > 0 ? setConfirmDelete(true) : remove())} />}
      </div>
      {readers.length > 0 && (
        <p className={HINT}>{`Read by ${readers.length === 1 ? 'one element' : `${readers.length} elements`}: ${readerNames.join(', ')}`}</p>
      )}
      {confirmDelete && (
        <div className="flex flex-col gap-1.5 rounded-[6px] border border-destructive/40 p-2" role="group" aria-label={`Delete ${name}?`}>
          <p className={REASON}>{`Deleting ${name} stops what reads it from working until it is back: ${readerNames.join(', ')}.`}</p>
          <div className="flex gap-1.5">
            <button type="button" className={SMALL_BUTTON} onClick={remove}>{`Delete ${name}`}</button>
            {/* The question takes the focus, on the choice that loses nothing; keeping it gives the focus back to the row's delete. */}
            <button
              type="button"
              autoFocus
              className={SMALL_BUTTON}
              onClick={() => {
                setConfirmDelete(false);
                requestFocus([inStateRow(id, ROW_DELETE)]);
              }}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
      {preset && <p className={HINT}>{"Made by a preset, which writes it again when the preset changes. Its name and first value are yours; the rest is the preset's."}</p>}
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>Type</span>
          <select
            aria-label={`Type of ${name}`}
            value={pendingType ?? (isStateType(entry.type) ? entry.type : '')}
            disabled={preset}
            onChange={(event) => {
              const type = event.target.value;
              setPendingType(isStateType(type) && type !== entry.type ? type : null);
            }}
            className={cn(FIELD_CONTROL, 'cursor-pointer')}
          >
            {!isStateType(entry.type) && <option value="">Unknown</option>}
            {STATE_TYPES.map((option) => <option key={option.type} value={option.type}>{option.label}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>First value</span>
          <ValueControl state={entry} value={entry.initial} aria-label={`First value of ${name}`} onChange={(value) => {
            if (value !== undefined) commit({ ...entry, initial: value });
          }} />
        </label>
      </div>
      {pendingType && isStateType(pendingType) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={HINT}>{`Its first value starts again${readers.length > 0 ? ', and what reads it must still fit' : ''}.`}</span>
          <button
            type="button"
            className={cn(SMALL_BUTTON, 'border-brand text-brand')}
            onClick={() => {
              if (commit(retype(entry, pendingType) as unknown as StoredRecord)) setPendingType(null);
            }}
          >
            {`Change to ${STATE_TYPES.find((option) => option.type === pendingType)?.label ?? pendingType}`}
          </button>
          <button type="button" className={SMALL_BUTTON} onClick={() => setPendingType(null)}>Keep the type</button>
        </div>
      )}
      {entry.type === 'choice' && (
        <label className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>Options, separated by commas</span>
          <CommitField
            aria-label={`Options of ${name}`}
            disabled={preset}
            value={Array.isArray(entry.options) ? entry.options.join(', ') : ''}
            onCommit={(text) => {
              const options = optionsFromText(text);
              // The first value follows when the option it held is gone, so the value stays one the state can hold.
              const initial = options.includes(String(entry.initial)) ? entry.initial : options[0];
              commit({ ...entry, options, initial });
            }}
          />
        </label>
      )}
      {entry.type === 'number' && (
        <div className="grid grid-cols-3 gap-1.5">
          {numberField('min')}
          {numberField('max')}
          {numberField('step')}
        </div>
      )}
      {entry.type === 'text' && (
        <CommitField
          aria-label={`Longest text of ${name}`}
          disabled={preset}
          numeric
          placeholder="no limit"
          value={valueText(entry.maxLength)}
          onCommit={(text) => {
            if (text.trim() === '') {
              const next = { ...entry };
              delete next.maxLength;
              return commit(next);
            }
            commit({ ...entry, maxLength: Number(text) });
          }}
        />
      )}
      <label className="flex min-w-0 flex-col gap-1">
        <span className={FIELD_LABEL}>Preview on the canvas</span>
        <ValueControl
          state={entry}
          value={preview}
          allowFirst
          disabled={interact || reason !== undefined}
          aria-label={`Preview ${name}`}
          onChange={(value) => editorUI.setPreviewValue(id, value)}
        />
      </label>
      {interact && <p className={HINT}>The page runs in Interact from its first values, so there is no preview here.</p>}
      {reason && <p className={REASON}>Not used: {reason}.</p>}
      {shownError && <p role="alert" className={REASON}>Not changed: {shownError}.</p>}
    </div>
  );
});

StateRow.displayName = 'StateRow';

function DeleteButton({ label, onClick, row }: { label: string; onClick: () => void; row?: boolean }) {
  return (
    <button type="button" data-delete-value={row ? '' : undefined} aria-label={label} title={label} onClick={onClick} className={cn(SMALL_BUTTON, 'w-7 flex-none px-0')}>
      <Trash2 size={12} aria-hidden />
    </button>
  );
}
