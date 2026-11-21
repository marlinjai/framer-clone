'use client';
// src/components/sidebars/right/sections/InteractionsSection.tsx
//
// The Interactions section (docs/plans/2026-11-02-behaviour-model.md, "The panel", slice B11)
// for the selected element. Each stored trigger is one sentence, "On click, toggle Menu
// open". The event list starts with Click, Mouse enter, Mouse leave, Focus, Keys and
// Appears, then "All events" with every other name the format takes. Actions are pickers,
// not text. "Show when" and the "Hide without JavaScript" switch live here too, and an
// address that leaves the site is typed here by a person, nowhere else.
//
// An interaction is edited as a draft and saved as one undo step. The draft is checked by
// the parser against the whole page before it is written (and, inside a component
// definition, against every page placing it: behaviourRefusal), and the parser's reason is
// what shows when it refuses. A stored entry the parser refuses (a value it reads was deleted,
// say) stays stored and shows its reason; it can be edited or deleted. Entries a preset
// wrote carry its mark and are shown, not edited: the preset writes them again.

import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { MousePointerClick, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { useStore } from '@/hooks/useStore';
import { isSafeHref } from '@/lib/links/safeHref';
import { getSnapshot } from 'mobx-state-tree';
import { leavesSite, type BehaviourNode, type StateValue } from '@/lib/behaviour/format';
import { editPresetItems, idsInUse, presetItemsOf, type PresetEdit } from '@/lib/behaviour/presetItems';
import { fitsState } from '@/lib/behaviour/surfaceBehaviour';
import {
  ALL_EVENTS,
  CUSTOM_EVENT_CHOICE,
  MEDIA_VALUE_OPS,
  QUICK_EVENTS,
  VERBS,
  VERB_OPS,
  defaultAction,
  describeAction,
  describeCondition,
  describeTrigger,
  firstAction,
  freshTriggerId,
  hasPicker,
  holdsNonList,
  isPlainCondition,
  isRecord,
  keysFromText,
  pathTo,
  pickerLabels,
  putEntry,
  putField,
  refusalText,
  refusalsOn,
  removeEntry,
  statesInReach,
  subtreeRefusals,
  storedBehaviourOf,
  storedList,
  verbOf,
  type StoredRecord,
} from '@/lib/behaviour/authoring';
import { CollapsibleSection, FIELD_CONTROL, FIELD_LABEL } from '../primitives';
import { CommitField, HINT, REASON, SMALL_BUTTON, SwitchRow, ValueControl, behaviourRefusal, expansionRoots, namesFor, placingRefusal, useFocusAfter, storedText, rootsOf, writeBehaviour, type BehaviourPage, type FocusTarget } from './behaviourShared';
import { cn } from '@/lib/utils';

interface InteractionsSectionProps {
  component: ComponentInstance;
}

/** Elements of the same tree a picker can name, by layer name. */
interface NodeChoice {
  id: string;
  name: string;
}

function nodeChoices(page: BehaviourPage, root: { id?: unknown; type?: unknown; children?: unknown }): NodeChoice[] {
  const out: NodeChoice[] = [];
  const walk = (node: { id?: unknown; type?: unknown; children?: unknown }) => {
    if (typeof node.id === 'string' && node.type !== '#text') {
      const live = page.findComponent(node.id);
      out.push({ id: node.id, name: live?.displayName ?? String(node.type) });
    }
    if (Array.isArray(node.children)) node.children.filter(isRecord).forEach(walk);
  };
  walk(root);
  return out;
}

export const InteractionsSection = observer(({ component }: InteractionsSectionProps) => {
  const { editorUI } = useStore();
  const page = editorUI.currentPage as unknown as BehaviourPage | undefined;
  // Drafts belong to one element: picking another closes them (RightSidebar keys this by id too).
  // An open editor names its trigger by node, place and id, and holds the whole stored trigger it opened on.
  const [editing, setEditing] = useState<{ nodeId: string; index: number; triggerId: string; base: string } | null>(null);
  const [adding, setAdding] = useState<{ nodeId: string; draft: StoredRecord } | null>(null);
  const focus = useFocusAfter();
  if (!page) return null;
  const roots = rootsOf(page);
  const found = pathTo(roots, component.id);
  const stored = storedBehaviourOf(component.props);
  const refused = refusalsOn(roots, component.id);

  if (!found) return null;
  if (stored === null) {
    return (
      <Shell focus={focus}>
        <p className={REASON}>Its behaviour is not used: {refused[0]?.reason ?? 'behaviour is an object'}.</p>
        <button type="button" className={SMALL_BUTTON} onClick={() => writeBehaviour(component, undefined)}>Remove what cannot be read</button>
      </Shell>
    );
  }

  const reach = statesInReach(roots, component.id);
  const states = reach.map((entry) => entry.state);
  const names = namesFor(page, states);
  const nodes = nodeChoices(page, found.root);
  const triggers = storedList(stored, 'on');
  const context = { states, selfId: component.id };

  const editingHere = editing && editing.nodeId === component.id ? editing : null;
  const addingHere = adding && adding.nodeId === component.id ? adding : null;

  /** Checks a trigger on this node against the whole page, and writes it when the parser takes it. */
  const save = (trigger: StoredRecord, index?: number): string | null => {
    const next = putEntry(stored, 'on', trigger, index);
    const reason = behaviourRefusal(page, component, next, trigger, names.node);
    if (reason) return reason;
    writeBehaviour(component, next);
    return null;
  };

  /** Focus after a write: a row's Edit button, then the next one, then the one before, then Add interaction. */
  const rowThenAdd = (index: number) => [index, index - 1].map((at) => `[data-trigger-index="${at}"] button[aria-label^="Edit:"]`).concat('[data-add-interaction]');

  return (
    <Shell focus={focus}>
      <PresetItemControls component={component} page={page} requestFocus={focus.request} />
      {holdsNonList(stored, 'on') && (
        <p className={REASON}>Its interactions are not used: {refused.find((r) => r.entry === 'on')?.reason ?? 'on is a list'}.</p>
      )}
      {triggers.length === 0 && !addingHere && <p className={HINT}>Nothing happens here yet. Add an interaction to make this element do something.</p>}
      <ul className="flex flex-col gap-1.5" aria-label="Interactions">
        {triggers.map((trigger, index) => {
          const reason = refused.find((r) => r.entry === 'on' && r.index === index)?.reason;
          const sentence = describeTrigger(trigger, names);
          const preset = isRecord(trigger) && trigger.preset === true;
          const base = storedText(trigger);
          const triggerId = isRecord(trigger) && typeof trigger.id === 'string' ? trigger.id : '';
          // An open editor whose stored entry changed (an undo, another tab, an AI edit) closes rather than save
          // over it: compared whole, so a change past any length counts.
          if (editingHere && editingHere.index === index && editingHere.triggerId === triggerId && editingHere.base === base) {
            return (
              <li key={`edit-${index}`}>
                <TriggerEditor
                  key={`edit-${component.id}-${index}-${triggerId}`}
                  initial={isRecord(trigger) ? trigger : { id: freshTriggerId(stored), on: 'click', do: [firstAction(context)] }}
                  states={states}
                  nodes={nodes}
                  selfId={component.id}
                  saveLabel="Save"
                  onSave={(draft) => {
                    const reasonNow = save(draft, index);
                    if (!reasonNow) {
                      setEditing(null);
                      focus.request(rowThenAdd(index), `Saved: ${describeTrigger(draft, names)}`);
                    }
                    return reasonNow;
                  }}
                  onCancel={() => {
                    setEditing(null);
                    focus.request(rowThenAdd(index));
                  }}
                />
              </li>
            );
          }
          return (
            <li key={`row-${index}`} data-trigger-index={index} className="flex flex-col gap-1 rounded-[6px] border border-border p-2">
              <div className="flex items-start gap-1.5">
                <span className="min-w-0 flex-1 text-[12px] leading-snug text-foreground">{sentence}</span>
                {!preset && (
                  <>
                    <IconButton label={`Edit: ${sentence}`} onClick={() => { setAdding(null); setEditing({ nodeId: component.id, index, triggerId, base }); }}>
                      <Pencil size={12} aria-hidden />
                    </IconButton>
                    <IconButton
                      label={`Delete: ${sentence}`}
                      onClick={() => {
                        setEditing(null);
                        writeBehaviour(component, removeEntry(stored, 'on', index));
                        focus.request(rowThenAdd(index), `Deleted: ${sentence}`);
                      }}
                    >
                      <Trash2 size={12} aria-hidden />
                    </IconButton>
                  </>
                )}
              </div>
              {preset && <p className={HINT}>Made by a preset, which writes it again when the preset changes.</p>}
              {reason && <p className={REASON}>Does not run: {reason}.</p>}
            </li>
          );
        })}
      </ul>
      {addingHere ? (
        <TriggerEditor
          key={`add-${component.id}-${String(addingHere.draft.id)}`}
          initial={addingHere.draft}
          states={states}
          nodes={nodes}
          selfId={component.id}
          saveLabel="Add"
          onSave={(draft) => {
            const reason = save(draft);
            if (!reason) {
              setAdding(null);
              focus.request(['[data-add-interaction]'], `Added: ${describeTrigger(draft, names)}`);
            }
            return reason;
          }}
          onCancel={() => {
            setAdding(null);
            focus.request(['[data-add-interaction]']);
          }}
        />
      ) : (
        !holdsNonList(stored, 'on') && (
          <button
            type="button"
            data-add-interaction=""
            className={SMALL_BUTTON}
            onClick={() => {
              setEditing(null);
              setAdding({ nodeId: component.id, draft: { id: freshTriggerId(stored), on: 'click', do: [firstAction(context)] } });
            }}
          >
            <Plus size={12} aria-hidden className="mr-1" /> Add interaction
          </button>
        )
      )}
      {states.length === 0 && <p className={HINT}>To show, hide or switch something, add a value in Page state first.</p>}
      <ShowWhen component={component} page={page} stored={stored} states={states} names={names} reason={refused.find((r) => r.entry === 'showWhen')?.reason} />
      <NoScriptSwitch component={component} page={page} stored={stored} names={names} />
      <Bindings component={component} stored={stored} names={names} refused={refused} />
    </Shell>
  );
});

InteractionsSection.displayName = 'InteractionsSection';

/**
 * Adds or takes out a preset's items, through the preset's own functions, as one undo step.
 * New ids avoid every id the page uses or names. Taking a tab out is two steps, a pick and
 * a press, so a key moving through the list (which fires a change in some browsers)
 * never takes one out. A preview the preset's values can no longer hold is dropped.
 *
 * The edited subtree goes through the parser on the whole page first, as every other
 * write here does (`subtreeRefusals`). An edit the parser would refuse elsewhere (a new
 * tab past the page's size cap) is not made, and says why. A removal that leaves an
 * entry naming a node it takes away (a trigger focusing that tab's panel) asks first,
 * naming the elements that would stop working.
 */
const PresetItemControls = observer(({ component, page, requestFocus }: {
  component: ComponentInstance;
  page: BehaviourPage;
  /** The section's focus mover (useFocusAfter): a removal takes away the control that had the focus. */
  requestFocus: (targets: readonly FocusTarget[], said?: string) => void;
}) => {
  const { editorUI } = useStore();
  const [picked, setPicked] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A removal waiting for its confirmation, tied to the subtree it was asked on: an undo or
  // another edit underneath closes the question rather than answer it for something else.
  const [confirm, setConfirm] = useState<{ index: number; base: string; readers: string[] } | null>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const snapshot = getSnapshot(component) as unknown as StoredRecord;
  const items = presetItemsOf(snapshot);
  if (!items) return null;
  const nameOf = (id: string) => `"${page.findComponent(id)?.displayName ?? id}"`;
  const apply = (edit: PresetEdit, confirmed = false) => {
    const current = getSnapshot(component) as unknown as StoredRecord;
    const roots = rootsOf(page);
    const next = editPresetItems(current, edit, idsInUse(roots));
    if (!next) return;
    // Judged on the page as it really expands, so a placement a copied panel holds counts with its definition.
    const expanded = page.expansionWith(next as { id: string });
    if (!expanded) return setError('this element is no longer on the page.');
    const check = subtreeRefusals(roots, expansionRoots(expanded), current as unknown as BehaviourNode, next as unknown as BehaviourNode);
    const hard = check.refused[0];
    if (hard) {
      setConfirm(null);
      return setError(`${refusalText(hard, component.id, nameOf)}.`);
    }
    // Inside a definition, the pages that place it are judged too, before any question: a
    // reader there out of sight refuses outright, so a confirmation is never a dead end.
    const placing = placingRefusal(page, next as { id: string }, current as unknown as { id: string });
    if (placing) {
      setConfirm(null);
      return setError(`${placing}.`);
    }
    // Only a removal takes nodes away, so only a removal has dangling entries to ask about.
    if (check.dangling.length > 0 && edit.kind === 'removeTab' && !confirmed) {
      const readers = [...new Set(check.dangling.map((refusal) => refusal.nodeId ?? ''))].map((id) => page.findComponent(id)?.displayName ?? (id || 'an element'));
      setError(null);
      return setConfirm({ index: edit.index, base: storedText(current), readers });
    }
    setConfirm(null);
    const written = component.replaceSubtree(next);
    setError(written.ok ? null : written.reason);
    if (!written.ok) return;
    setPicked('');
    // After a removal the Remove button is off and the question is gone, so the focus goes to
    // the tab picker (or Add, when one tab is left and the picker is gone), and what happened is said.
    const before = presetItemsOf(current);
    if (edit.kind === 'removeTab') requestFocus(['select[data-item-picker]', 'button[data-add-item]'], `Removed ${before?.items[edit.index] ?? 'the tab'}`);
    else requestFocus([], `Added ${presetItemsOf(next)?.items.at(-1) ?? 'one'}`);
    const now = storedBehaviourOf(component.props);
    for (const state of now ? storedList(now, 'state') : []) {
      if (!isRecord(state) || typeof state.id !== 'string') continue;
      const previewed = editorUI.previewState[state.id];
      if (previewed !== undefined && !fitsState(state as never, previewed)) editorUI.setPreviewValue(state.id, undefined);
    }
  };
  const noun = items.kind === 'tabs' ? 'tab' : 'slide';
  const pickedIndex = picked === '' ? -1 : Number(picked);
  const asking = confirm && confirm.base === storedText(snapshot) && confirm.index === pickedIndex ? confirm : null;
  const askedTitle = asking ? items.items[asking.index] ?? 'the picked tab' : '';
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={items.kind === 'tabs' ? 'Tabs' : 'Slides'}>
      <span className={FIELD_LABEL}>{`${items.items.length} ${noun}s, made from a preset`}</span>
      <button type="button" data-add-item="" className={cn(SMALL_BUTTON, 'self-start')} onClick={() => apply(items.kind === 'tabs' ? { kind: 'addTab' } : { kind: 'addSlide' })}>
        <Plus size={12} aria-hidden className="mr-1" /> {`Add ${noun}`}
      </button>
      {items.canRemove && (
        <div className="flex gap-1.5">
          <select
            data-item-picker=""
            aria-label="Tab to remove"
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
            className={cn(FIELD_CONTROL, 'min-w-0 flex-1 cursor-pointer')}
          >
            <option value="">Pick a tab to remove</option>
            {items.items.map((title, index) => <option key={index} value={index}>{title}</option>)}
          </select>
          <button
            ref={removeRef}
            type="button"
            className={SMALL_BUTTON}
            disabled={pickedIndex < 0}
            aria-label={pickedIndex < 0 ? 'Remove the picked tab' : `Remove ${items.items[pickedIndex] ?? 'the picked tab'}`}
            onClick={() => apply({ kind: 'removeTab', index: pickedIndex })}
          >
            Remove
          </button>
        </div>
      )}
      {asking && (
        <div className="flex flex-col gap-1.5 rounded-[6px] border border-destructive/40 p-2" role="group" aria-label={`Remove ${askedTitle}?`}>
          <p className={REASON}>{`Removing ${askedTitle} stops what names it from working: ${asking.readers.join(', ')}.`}</p>
          <div className="flex gap-1.5">
            <button type="button" className={SMALL_BUTTON} onClick={() => apply({ kind: 'removeTab', index: asking.index }, true)}>{`Remove ${askedTitle} anyway`}</button>
            {/* The question takes the focus, on the choice that loses nothing; keeping it gives the focus back to Remove. */}
            <button
              type="button"
              autoFocus
              className={SMALL_BUTTON}
              onClick={() => {
                setConfirm(null);
                removeRef.current?.focus();
              }}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className={REASON}>Not changed: {error}</p>}
    </div>
  );
});

PresetItemControls.displayName = 'PresetItemControls';

function Shell({ children, focus }: { children: React.ReactNode; focus: ReturnType<typeof useFocusAfter> }) {
  return (
    <div data-testid="interactions-section" ref={focus.ref}>
      <CollapsibleSection title="Interactions" icon={<MousePointerClick size={14} />} normalOnly>
        {children}
      </CollapsibleSection>
      {focus.live}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cn(SMALL_BUTTON, 'w-7 flex-none px-0')}>
      {children}
    </button>
  );
}

// --- one interaction, as a draft --------------------------------------------------------

interface TriggerEditorProps {
  initial: StoredRecord;
  states: readonly StateValue[];
  nodes: readonly NodeChoice[];
  selfId: string;
  saveLabel: string;
  /** Writes the draft; returns the parser's reason when it refuses it. */
  onSave: (draft: StoredRecord) => string | null;
  onCancel: () => void;
}

const isKeyEvent = (on: unknown) => on === 'keydown' || on === 'keyup';
const isDomName = (on: unknown) => typeof on === 'string' && !on.startsWith('custom:') && !['view-enter', 'view-leave', 'page-ready', 'every'].includes(on);

function TriggerEditor({ initial, states, nodes, selfId, saveLabel, onSave, onCancel }: TriggerEditorProps) {
  const [draft, setDraft] = useState<StoredRecord>(initial);
  const [reason, setReason] = useState<string | null>(null);
  const [keysText, setKeysText] = useState(Array.isArray(initial.keys) ? initial.keys.map(String).join(', ') : '');
  const [keysError, setKeysError] = useState<string | null>(null);
  // Opening the editor takes the focus to its first field, since the button that opened it is gone.
  const eventRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    eventRef.current?.focus();
  }, []);
  // Adding or removing an action swaps the control pressed for another: the focus goes to the
  // new action's field, or after a removal to the action before (or the one now in its place),
  // else to Add action, so it never falls back to the page.
  const groupRef = useRef<HTMLDivElement>(null);
  const [focusAction, setFocusAction] = useState<number | null>(null);
  useEffect(() => {
    if (focusAction === null) return;
    const group = groupRef.current;
    const target =
      group?.querySelector<HTMLElement>(`select[aria-label="Action ${focusAction}"]`) ??
      group?.querySelector<HTMLElement>('[data-add-action]');
    target?.focus();
    setFocusAction(null);
  }, [focusAction]);
  const change = (next: StoredRecord) => {
    setDraft(next);
    setReason(null);
  };
  const on = typeof draft.on === 'string' ? draft.on : '';
  const custom = on.startsWith('custom:');
  const actions = Array.isArray(draft.do) ? draft.do : [];
  // An address the field marks as unsafe is never saved: Save waits until it is one.
  const unsafeAddress = actions.some((action) => verbOf(action) === 'navigate' && isRecord(action) && !(typeof action.navigate === 'string' && action.navigate !== '' && isSafeHref(action.navigate)));

  const setEvent = (value: string) => {
    let next = putField(draft, 'on', value === CUSTOM_EVENT_CHOICE ? 'custom:open' : value);
    // Fields one event takes and the next does not go with it, so a switch never leaves a refusal behind.
    if (!isKeyEvent(next.on)) {
      next = putField(next, 'keys', undefined);
      setKeysText('');
      setKeysError(null);
    }
    next = putField(next, 'ms', next.on === 'every' ? (typeof draft.ms === 'number' ? draft.ms : 5000) : undefined);
    if (!isDomName(next.on)) next = putField(next, 'prevent', undefined);
    change(next);
  };

  return (
    <div ref={groupRef} className="flex flex-col gap-2 rounded-[6px] border border-brand/40 p-2" role="group" aria-label="Interaction">
      <label className="flex min-w-0 flex-col gap-1">
        <span className={FIELD_LABEL}>When</span>
        <select ref={eventRef} aria-label="Event" value={custom ? CUSTOM_EVENT_CHOICE : on} onChange={(event) => setEvent(event.target.value)} className={cn(FIELD_CONTROL, 'cursor-pointer')}>
          {QUICK_EVENTS.map((entry) => <option key={entry.on} value={entry.on}>{entry.label}</option>)}
          <optgroup label="All events">
            {ALL_EVENTS.map((name) => <option key={name} value={name}>{name}</option>)}
            <option value={CUSTOM_EVENT_CHOICE}>A custom event</option>
          </optgroup>
        </select>
      </label>
      {custom && (
        <CommitField aria-label="Custom event name" value={on.slice('custom:'.length)} onCommit={(text) => change(putField(draft, 'on', `custom:${text.trim()}`))} />
      )}
      {isKeyEvent(on) && (
        <label className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>Keys, separated by commas (empty: any key)</span>
          <input
            type="text"
            aria-label="Keys"
            aria-invalid={keysError ? true : undefined}
            value={keysText}
            placeholder="Enter, Escape"
            onChange={(event) => {
              const text = event.target.value;
              setKeysText(text);
              const read = keysFromText(text);
              if ('error' in read) {
                setKeysError(read.error);
                return;
              }
              setKeysError(null);
              change(putField(draft, 'keys', read.keys.length > 0 ? read.keys : undefined));
            }}
            className={FIELD_CONTROL}
          />
          {keysError && <span role="alert" className={REASON}>{keysError}</span>}
        </label>
      )}
      {on === 'every' && (
        <label className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>Every how many seconds</span>
          <CommitField
            aria-label="Seconds between"
            numeric
            value={String((typeof draft.ms === 'number' ? draft.ms : 5000) / 1000)}
            onCommit={(text) => {
              const seconds = Number(text);
              if (Number.isFinite(seconds)) change(putField(draft, 'ms', Math.round(seconds * 1000)));
            }}
          />
        </label>
      )}
      {isDomName(on) && (
        <SwitchRow
          label="Stop the browser's own response"
          hint="A form does not send, a key does not scroll."
          checked={draft.prevent === true}
          onCheckedChange={(checked) => change(putField(draft, 'prevent', checked ? true : undefined))}
        />
      )}
      {(draft.if !== undefined || draft.scope !== undefined) && (
        <p className={HINT}>Also holds {draft.if !== undefined ? 'a condition' : ''}{draft.if !== undefined && draft.scope !== undefined ? ' and ' : ''}{draft.scope !== undefined ? 'a page-wide listener' : ''}, kept as it is.</p>
      )}
      <span className={FIELD_LABEL}>Then</span>
      {actions.map((action, index) => (
        <ActionEditor
          key={index}
          index={index}
          action={action}
          states={states}
          nodes={nodes}
          selfId={selfId}
          onChange={(next) => change(putField(draft, 'do', actions.map((entry, i) => (i === index ? next : entry))))}
          onRemove={() => {
            change(putField(draft, 'do', actions.filter((_, i) => i !== index)));
            setFocusAction(Math.max(index, 1));
          }}
        />
      ))}
      <button
        type="button"
        data-add-action=""
        className={SMALL_BUTTON}
        onClick={() => {
          change(putField(draft, 'do', [...actions, firstAction({ states, selfId })]));
          setFocusAction(actions.length + 1);
        }}
      >
        <Plus size={12} aria-hidden className="mr-1" /> Add action
      </button>
      {reason && <p role="alert" className={REASON}>Not saved: {reason}.</p>}
      <div className="flex gap-1.5">
        <button
          type="button"
          aria-label={`${saveLabel} this interaction`}
          className={cn(SMALL_BUTTON, 'border-brand text-brand')}
          disabled={keysError !== null || unsafeAddress}
          onClick={() => setReason(onSave(draft))}
        >
          {saveLabel}
        </button>
        <button type="button" className={SMALL_BUTTON} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// --- one action --------------------------------------------------------------------------

interface ActionEditorProps {
  index: number;
  action: unknown;
  states: readonly StateValue[];
  nodes: readonly NodeChoice[];
  selfId: string;
  onChange: (next: StoredRecord) => void;
  onRemove: () => void;
}

function ActionEditor({ index, action, states, nodes, selfId, onChange, onRemove }: ActionEditorProps) {
  const n = index + 1;
  const verb = verbOf(action);
  const record = isRecord(action) ? action : {};
  const names = {
    state: (id: string) => states.find((state) => state.id === id)?.name ?? id,
    node: (id: string) => nodes.find((node) => node.id === id)?.name ?? id,
  };
  const remove = (
    <button type="button" aria-label={`Remove action ${n}`} title={`Remove action ${n}`} onClick={onRemove} className={cn(SMALL_BUTTON, 'w-7 flex-none px-0')}>
      <Trash2 size={12} aria-hidden />
    </button>
  );

  // A verb with no picker here (a preset's `rove`, `filter`, `delay`) is shown and can be removed.
  if (!hasPicker(verb)) {
    return (
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">{describeAction(action, names)}, kept as it is</span>
        {remove}
      </div>
    );
  }
  const target = typeof record[verb as string] === 'string' ? (record[verb as string] as string) : '';
  const stateTypes = verb === 'toggle' ? ['boolean'] : verb === 'step' ? ['number', 'choice'] : ['boolean', 'number', 'choice', 'text'];
  const fitting = states.filter((state) => stateTypes.includes(state.type));
  const state = states.find((entry) => entry.id === target);
  const labels = pickerLabels(states);

  return (
    <div className="flex flex-col gap-1.5 border-l-2 border-border pl-2" role="group" aria-label={`Step ${n} of this interaction`}>
      <div className="flex items-center gap-1.5">
        <select
          aria-label={`Action ${n}`}
          value={verb as string}
          onChange={(event) => onChange(defaultAction(event.target.value, { states, selfId }))}
          className={cn(FIELD_CONTROL, 'cursor-pointer')}
        >
          {VERBS.map((entry) => <option key={entry.verb} value={entry.verb}>{entry.label}</option>)}
        </select>
        {remove}
      </div>
      {(verb === 'set' || verb === 'toggle' || verb === 'step') && (
        fitting.length === 0 ? (
          <p className={HINT}>No {verb === 'toggle' ? 'on or off value' : verb === 'step' ? 'number or choice' : 'value'} in reach. Add one in Page state.</p>
        ) : (
          <select
            aria-label={`Value to change in action ${n}`}
            value={state ? target : ''}
            onChange={(event) => {
              const picked = states.find((entry) => entry.id === event.target.value);
              if (!picked) return;
              onChange(verb === 'set' ? { ...record, set: picked.id, value: picked.initial } : { ...record, [verb as string]: picked.id });
            }}
            className={cn(FIELD_CONTROL, 'cursor-pointer')}
          >
            {!state && <option value="">{target ? `A value out of reach (${target})` : 'Pick a value'}</option>}
            {fitting.map((entry) => <option key={entry.id} value={entry.id}>{labels.get(entry.id) ?? entry.name}</option>)}
          </select>
        )
      )}
      {verb === 'set' && state && (
        isRecord(record.value) ? (
          <p className={HINT}>Set from an expression, kept as it is.</p>
        ) : (
          <ValueControl state={state as unknown as StoredRecord} value={record.value} aria-label={`New value in action ${n}`} onChange={(value) => {
            if (value !== undefined) onChange({ ...record, value });
          }} />
        )
      )}
      {verb === 'step' && state && (
        <div className="flex flex-col gap-1.5">
          <CommitField aria-label={`Step by in action ${n}`} numeric placeholder="1" value={typeof record.by === 'number' ? String(record.by) : ''} onCommit={(text) => {
            const by = Number(text);
            const next = { ...record };
            if (text.trim() === '' || !Number.isFinite(by)) delete next.by;
            else next.by = by;
            onChange(next);
          }} />
          <SwitchRow
            label="Wrap around"
            name={`Wrap around in action ${n}`}
            hint="Past the last, back to the first."
            checked={record.wrap === true}
            onCheckedChange={(checked) => {
              const next = { ...record };
              if (checked) next.wrap = true;
              else delete next.wrap;
              onChange(next);
            }}
          />
        </div>
      )}
      {['focus', 'scroll', 'dialog', 'popover', 'details', 'media', 'fullscreen', 'pictureInPicture', 'form', 'effect'].includes(verb as string) && (
        <select aria-label={`Element in action ${n}`} value={nodes.some((node) => node.id === target) ? target : ''} onChange={(event) => onChange({ ...record, [verb as string]: event.target.value })} className={cn(FIELD_CONTROL, 'cursor-pointer')}>
          {!nodes.some((node) => node.id === target) && <option value="">{target ? `An element that is gone (${target})` : 'Pick an element'}</option>}
          {nodes.map((node) => <option key={node.id} value={node.id}>{node.id === selfId ? `${node.name} (this one)` : node.name}</option>)}
        </select>
      )}
      {verb && VERB_OPS[verb] && (
        <select aria-label={`What to do in action ${n}`} value={String(record.op ?? '')} onChange={(event) => {
          const next: StoredRecord = { ...record, op: event.target.value };
          if (verb === 'media') {
            if (MEDIA_VALUE_OPS.has(event.target.value)) next.value = typeof record.value === 'number' ? record.value : event.target.value === 'seek' ? 0 : 1;
            else delete next.value;
          }
          onChange(next);
        }} className={cn(FIELD_CONTROL, 'cursor-pointer')}>
          {VERB_OPS[verb].map((entry) => <option key={entry.op} value={entry.op}>{entry.label}</option>)}
        </select>
      )}
      {verb === 'media' && MEDIA_VALUE_OPS.has(String(record.op)) && (
        <CommitField aria-label={`Amount in action ${n}`} numeric value={typeof record.value === 'number' ? String(record.value) : ''} onCommit={(text) => {
          const value = Number(text);
          if (text.trim() !== '' && Number.isFinite(value)) onChange({ ...record, value });
        }} />
      )}
      {verb === 'navigate' && <AddressField index={n} value={target} onChange={(href) => onChange({ ...record, navigate: href })} />}
      {(verb === 'emit' || verb === 'cancel') && (
        <CommitField aria-label={verb === 'emit' ? `Event name in action ${n}` : `Delay name in action ${n}`} value={target} onCommit={(text) => onChange({ ...record, [verb]: text.trim() })} />
      )}
    </div>
  );
}

/** An address a person types: checked as it is typed, and named when it leaves the site. */
function AddressField({ index, value, onChange }: { index: number; value: string; onChange: (href: string) => void }) {
  const [draft, setDraft] = useState(value);
  const safe = draft.trim() !== '' && isSafeHref(draft.trim());
  return (
    <div className="flex flex-col gap-1">
      <input
        type="text"
        aria-label={`Address in action ${index}`}
        aria-invalid={safe ? undefined : true}
        value={draft}
        placeholder="/contact"
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          // Passed on as typed: the draft then holds what the field shows, and Save stays off while it is not safe.
          onChange(next.trim());
        }}
        className={cn(FIELD_CONTROL, 'font-mono text-[11px]')}
      />
      {!safe && <span role="alert" className={REASON}>Use a page path (/contact), #section, https://, mailto: or tel:</span>}
      {safe && leavesSite(draft.trim()) && <span className={HINT}>Leaves the site. It runs only on a press, so a visitor always chose it.</span>}
    </div>
  );
}

// --- show when -----------------------------------------------------------------------------

interface ShowWhenProps {
  component: ComponentInstance;
  page: BehaviourPage;
  stored: StoredRecord;
  states: readonly StateValue[];
  names: ReturnType<typeof namesFor>;
  reason?: string;
}

function ShowWhen({ component, page, stored, states, names, reason }: ShowWhenProps) {
  const [error, setError] = useState<{ reason: string; for: string } | null>(null);
  const condition = stored.showWhen;
  const key = storedText(condition);
  const write = (next: unknown) => {
    const behaviour = putField(stored, 'showWhen', next);
    const refusal = next === undefined ? null : behaviourRefusal(page, component, behaviour, next, names.node);
    if (refusal) {
      setError({ reason: refusal, for: key });
      return;
    }
    setError(null);
    writeBehaviour(component, behaviour);
  };
  const plain = isPlainCondition(condition) ? condition : null;
  const state = plain ? states.find((entry) => entry.id === plain.state) : undefined;
  const labels = pickerLabels(states);

  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Show when">
      <span className={FIELD_LABEL}>Show when</span>
      {condition !== undefined && !plain ? (
        <div className="flex items-start gap-1.5">
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">{describeCondition(condition, names)}, kept as it is</span>
          <button type="button" className={SMALL_BUTTON} onClick={() => write(undefined)}>Always show</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          <select
            aria-label="Show when value"
            value={plain ? plain.state : ''}
            onChange={(event) => {
              const picked = states.find((entry) => entry.id === event.target.value);
              write(picked ? { state: picked.id, eq: picked.type === 'boolean' ? true : picked.initial } : undefined);
            }}
            className={cn(FIELD_CONTROL, 'cursor-pointer')}
          >
            <option value="">Always</option>
            {plain && !state && <option value={plain.state}>{`A value out of reach (${plain.state})`}</option>}
            {states.map((entry) => <option key={entry.id} value={entry.id}>{labels.get(entry.id) ?? entry.name}</option>)}
          </select>
          {plain && state && (
            <ValueControl state={state as unknown as StoredRecord} value={plain.eq} aria-label="Show when it is" onChange={(value) => {
              if (value !== undefined) write({ state: plain.state, eq: value });
            }} />
          )}
        </div>
      )}
      {reason && <p className={REASON}>Shown always: {reason}.</p>}
      {error && error.for === key && <p role="alert" className={REASON}>Not changed: {error.reason}.</p>}
    </div>
  );
}

/**
 * The "Hide without JavaScript" switch, checked on the whole page like every other write:
 * turning it on adds bytes, which can take the page past its size cap.
 */
function NoScriptSwitch({ component, page, stored, names }: { component: ComponentInstance; page: BehaviourPage; stored: StoredRecord; names: ReturnType<typeof namesFor> }) {
  const [error, setError] = useState<{ reason: string; for: string } | null>(null);
  const key = storedText(stored.noScript);
  return (
    <div className="flex flex-col gap-1.5">
      <SwitchRow
        label="Hide without JavaScript"
        hint="For a control that only works with scripts on."
        checked={stored.noScript === 'hide'}
        onCheckedChange={(checked) => {
          const next = putField(stored, 'noScript', checked ? 'hide' : undefined);
          const refusal = behaviourRefusal(page, component, next, undefined, names.node);
          if (refusal) return setError({ reason: refusal, for: key });
          setError(null);
          writeBehaviour(component, next);
        }}
      />
      {error && error.for === key && <p role="alert" className={REASON}>Not changed: {error.reason}.</p>}
    </div>
  );
}

// --- bindings ------------------------------------------------------------------------------

function Bindings({ component, stored, names, refused }: { component: ComponentInstance; stored: StoredRecord; names: ReturnType<typeof namesFor>; refused: ReturnType<typeof refusalsOn> }) {
  const list = storedList(stored, 'bind');
  if (list.length === 0 && stored.group === undefined) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className={FIELD_LABEL}>Follows a value</span>
      {list.map((entry, index) => {
        const record = isRecord(entry) ? entry : {};
        const what = typeof record.attr === 'string' ? record.attr : typeof record.cssVar === 'string' ? record.cssVar : record.text !== undefined ? 'its text' : 'something unknown';
        const from = record.from ?? record.text;
        const source = isRecord(from) && typeof from.get === 'string' ? names.state(from.get) : 'an expression';
        const reason = refused.find((r) => r.entry === 'bind' && r.index === index)?.reason;
        const preset = record.preset === true;
        return (
          <div key={index} className="flex flex-col gap-1">
            <div className="flex items-start gap-1.5">
              <span className="min-w-0 flex-1 text-[11px] leading-snug text-foreground">{`${what} follows ${source}`}</span>
              {!preset && (
                <IconButton label={`Delete: ${what} follows ${source}`} onClick={() => writeBehaviour(component, removeEntry(stored, 'bind', index))}>
                  <Trash2 size={12} aria-hidden />
                </IconButton>
              )}
            </div>
            {reason && <p className={REASON}>Not written: {reason}.</p>}
          </div>
        );
      })}
      {stored.group !== undefined && <p className={HINT}>Arrow keys move between its items (a focus group a preset made).</p>}
    </div>
  );
}
