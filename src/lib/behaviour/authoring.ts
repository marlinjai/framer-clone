// src/lib/behaviour/authoring.ts
//
// What the panel needs to read and write stored behaviour: the Page state panel and the
// Interactions section (slice B11 of docs/plans/2026-11-02-behaviour-model.md, "The panel").
//
// Three rules hold everything here:
//
//   - Edits work on what is stored, of any shape, never on what the parser rebuilt. An
//     entry the parser refuses stays stored so the panel can show it with its reason, and
//     editing one field of a trigger keeps every other field it holds (`if`, `scope`,
//     `preset`), including the ones the panel has no control for.
//   - The parser is the only judge. A value a person enters is checked by running it
//     through `parseBehaviour` or `readBehaviourTree` before it is written, and the
//     reason the parser gives is the reason the panel shows. There is no second rule set.
//   - References use ids. A state's `name` is what a person reads; renaming it touches
//     one entry. State ids are fresh across the whole tree, so a new value never collides
//     with one declared further down or by a preset.
//
// `statesInReach` is what a later panel (the custom code section, which declares the
// page state a block reads and writes) reuses: the id, name and type of every value a
// node can see, and the node that declares it.
//
// PURE and client-safe: no React, no MST.

import {
  DOM_EVENTS,
  keyOfChord,
  parseBehaviour,
  readBehaviourTree,
  type BehaviourNode,
  type RefusedOnNode,
  type StateValue,
} from './format';

// --- what a state can be ----------------------------------------------------

export type StateType = StateValue['type'];

/** The four kinds of value, in the order the panel offers them. */
export const STATE_TYPES: readonly { type: StateType; label: string }[] = [
  { type: 'boolean', label: 'On or off' },
  { type: 'number', label: 'Number' },
  { type: 'choice', label: 'Choice' },
  { type: 'text', label: 'Text' },
];

export const isStateType = (value: unknown): value is StateType => STATE_TYPES.some((entry) => entry.type === value);

// --- events -------------------------------------------------------------------

/** The events a person reaches for first, in the order the plan lists them. */
export const QUICK_EVENTS: readonly { on: string; label: string }[] = [
  { on: 'click', label: 'Click' },
  { on: 'mouseenter', label: 'Mouse enter' },
  { on: 'mouseleave', label: 'Mouse leave' },
  { on: 'focus', label: 'Focus' },
  { on: 'keydown', label: 'Keys' },
  { on: 'view-enter', label: 'Appears' },
];

const PSEUDO_LABELS: Readonly<Record<string, string>> = {
  'view-leave': 'Leaves the view',
  'page-ready': 'Page is ready',
  every: 'Every few seconds',
};

export const isQuickEvent = (on: string): boolean => QUICK_EVENTS.some((entry) => entry.on === on);

/**
 * Every other event name the format takes, alphabetically: the "All events" list. A
 * custom event (`custom:<name>`) is typed, since its name is the author's.
 */
export const ALL_EVENTS: readonly string[] = [...DOM_EVENTS, ...Object.keys(PSEUDO_LABELS)]
  .filter((on) => !isQuickEvent(on))
  .sort((a, b) => a.localeCompare(b));

/** The value the event list uses for "a custom event", whose name is typed beside it. */
export const CUSTOM_EVENT_CHOICE = 'custom:';

/** How an event reads in a sentence: "click", "mouse enter", "keys", "the custom event open". */
export function eventLabel(on: unknown): string {
  if (typeof on !== 'string' || on === '') return 'an unknown event';
  const quick = QUICK_EVENTS.find((entry) => entry.on === on);
  if (quick) return quick.label.toLowerCase();
  if (on.startsWith('custom:')) return `the custom event ${on.slice('custom:'.length) || '(no name)'}`;
  return PSEUDO_LABELS[on]?.toLowerCase() ?? on;
}

// --- reading what is stored --------------------------------------------------

export type StoredRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is StoredRecord => !!value && typeof value === 'object' && !Array.isArray(value);

/** The stored behaviour of a node's props: an object, `{}` when absent, null when it is not an object at all. */
export function storedBehaviourOf(props: unknown): StoredRecord | null {
  const behaviour = isRecord(props) ? props.behaviour : undefined;
  if (behaviour === undefined) return {};
  return isRecord(behaviour) ? behaviour : null;
}

/** A stored list, or an empty one when the key holds something else (which the parser reports). */
export function storedList(stored: StoredRecord, key: 'state' | 'on' | 'bind'): unknown[] {
  const list = stored[key];
  return Array.isArray(list) ? list : [];
}

/** True when the stored key holds something that is not a list: the panel cannot add to it without dropping it. */
export const holdsNonList = (stored: StoredRecord, key: 'state' | 'on' | 'bind'): boolean =>
  stored[key] !== undefined && !Array.isArray(stored[key]);

// --- a tree -------------------------------------------------------------------

const childrenOf = (node: BehaviourNode): BehaviourNode[] =>
  Array.isArray(node.children) ? (node.children as unknown[]).filter(isRecord) as BehaviourNode[] : [];

/** The nodes from a root down to `nodeId`, both included, or null when no root holds it. */
export function pathTo(roots: readonly BehaviourNode[], nodeId: string): { root: BehaviourNode; path: BehaviourNode[] } | null {
  for (const root of roots) {
    const path: BehaviourNode[] = [];
    const find = (node: BehaviourNode): boolean => {
      path.push(node);
      if (node.id === nodeId) return true;
      if (childrenOf(node).some(find)) return true;
      path.pop();
      return false;
    };
    if (find(root)) return { root, path };
  }
  return null;
}

/** Every string a tree holds as a state id, valid or not: what a fresh id must avoid. */
function stateIdsIn(roots: readonly BehaviourNode[]): Set<string> {
  const taken = new Set<string>();
  const walk = (node: BehaviourNode) => {
    const stored = storedBehaviourOf(node.props);
    for (const entry of stored ? storedList(stored, 'state') : []) {
      if (isRecord(entry) && typeof entry.id === 'string') taken.add(entry.id);
    }
    childrenOf(node).forEach(walk);
  };
  roots.forEach(walk);
  return taken;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A state id no node of the tree uses: lower case, as the format asks, since it becomes
 * an attribute name. Unique across the whole tree rather than the path, so a value added
 * to the page root never refuses one a row or a preset declares further down.
 */
export function freshStateId(roots: readonly BehaviourNode[], random: () => number = Math.random): string {
  const taken = stateIdsIn(roots);
  for (;;) {
    let id = 'v-';
    for (let i = 0; i < 8; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
}

/** A trigger id the node does not hold yet. */
export function freshTriggerId(stored: StoredRecord, random: () => number = Math.random): string {
  const taken = new Set(storedList(stored, 'on').map((entry) => (isRecord(entry) ? entry.id : undefined)));
  for (;;) {
    let id = 't-';
    for (let i = 0; i < 8; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
}

/** A value in reach of a node, and where it is declared. */
export interface ReachableState {
  state: StateValue;
  /** The node declaring it. */
  scopeId: string | null;
  /** Declared on the node itself, rather than above it. */
  own: boolean;
}

/**
 * Every value a node can read and write, nearest scope last, as the parser accepts it.
 * A value the parser refuses is not in reach for anything, so it is not offered.
 */
export function statesInReach(roots: readonly BehaviourNode[], nodeId: string): ReachableState[] {
  const found = pathTo(roots, nodeId);
  if (!found) return [];
  const tree = readBehaviourTree(found.root);
  const out: ReachableState[] = [];
  for (const node of found.path) {
    for (const state of tree.behaviours.get(node)?.state ?? []) {
      out.push({ state, scopeId: typeof node.id === 'string' ? node.id : null, own: node.id === nodeId });
    }
  }
  return out;
}

/** What the parser refuses on one node, read against the whole tree it stands in. */
export function refusalsOn(roots: readonly BehaviourNode[], nodeId: string): RefusedOnNode[] {
  const found = pathTo(roots, nodeId);
  if (!found) return [];
  return readBehaviourTree(found.root).refused.filter((entry) => entry.nodeId === nodeId);
}

/** The tree with one node's behaviour replaced, copying only the path to it. Null when no node has the id. */
export function withBehaviourAt(root: BehaviourNode, nodeId: string, behaviour: StoredRecord | undefined): BehaviourNode | null {
  if (root.id === nodeId) {
    const props = isRecord(root.props) ? { ...root.props } : {};
    if (behaviour === undefined) delete props.behaviour;
    else props.behaviour = behaviour;
    return { ...root, props };
  }
  const children = childrenOf(root);
  for (let index = 0; index < children.length; index++) {
    const next = withBehaviourAt(children[index], nodeId, behaviour);
    if (next) return { ...root, children: children.map((child, i) => (i === index ? next : child)) };
  }
  return null;
}

// --- checking what a person entered ----------------------------------------------

/** Why the parser refuses this value on its own, or null when it takes it. */
export function stateRefusal(candidate: unknown): string | null {
  const read = parseBehaviour({ id: 'state-check', type: 'div', props: { behaviour: { state: [candidate] } } });
  return read.refused[0]?.reason ?? null;
}

/** What a check aims at on the node: one trigger by id, the show-when, or the no-JavaScript setting. */
export type CheckedEntry = { entry: 'on'; id: string } | { entry: 'showWhen' } | { entry: 'noScript' } | { entry: 'state'; id: string };

/**
 * Why the parser would refuse one entry of `behaviour` written on this node of this tree,
 * or null when it would take it. Read against the whole tree, so a reference to a node or
 * to state out of reach, an event a verb may not run from, and the node's own kind all count.
 */
export function refusalAt(roots: readonly BehaviourNode[], nodeId: string, behaviour: StoredRecord, aimed: CheckedEntry): string | null {
  const found = pathTo(roots, nodeId);
  if (!found) return 'this element is no longer on the page';
  const tree = withBehaviourAt(found.root, nodeId, behaviour);
  if (!tree) return 'this element is no longer on the page';
  const refused = readBehaviourTree(tree).refused.filter((entry) => entry.nodeId === nodeId);
  const whole = refused.find((entry) => entry.entry === 'behaviour' && entry.value === behaviour);
  if (whole) return whole.reason;
  const hit = refused.find((entry) => {
    if (entry.entry !== aimed.entry) return false;
    if (aimed.entry === 'on' || aimed.entry === 'state') return isRecord(entry.value) && entry.value.id === aimed.id;
    return true;
  });
  return hit?.reason ?? null;
}

// --- writing -----------------------------------------------------------------------

/** The stored behaviour with one list entry put at `index`, or appended when there is none. */
export function putEntry(stored: StoredRecord, key: 'state' | 'on' | 'bind', entry: unknown, index?: number): StoredRecord {
  const list = [...storedList(stored, key)];
  if (index === undefined || index < 0 || index >= list.length) list.push(entry);
  else list[index] = entry;
  return { ...stored, [key]: list };
}

/** The stored behaviour without the list entry at `index`. */
export function removeEntry(stored: StoredRecord, key: 'state' | 'on' | 'bind', index: number): StoredRecord {
  const list = storedList(stored, key).filter((_, i) => i !== index);
  return { ...stored, [key]: list };
}

/** The stored behaviour with one field set, or taken away with undefined. */
export function putField(stored: StoredRecord, key: string, value: unknown): StoredRecord {
  const next = { ...stored };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** True when two stored values read the same, so writing one over the other is no edit. */
export const sameStored = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// --- a value of each type ------------------------------------------------------------------

/** A new value of a type, with a first value that type can hold. */
export function newState(id: string, name: string, type: StateType): StateValue {
  switch (type) {
    case 'boolean':
      return { id, name, type, initial: false };
    case 'number':
      return { id, name, type, initial: 0 };
    case 'choice':
      return { id, name, type, initial: 'first', options: ['first', 'second'] };
    case 'text':
      return { id, name, type, initial: '' };
  }
}

/**
 * The same value as another type: its id, name and preset mark stay, the first value is
 * carried over where the new type can hold it and starts fresh otherwise. Fields the old
 * type had and the new one does not (`options`, `min`) go, since the parser refuses them.
 */
export function retype(stored: StoredRecord, type: StateType): StateValue {
  const id = typeof stored.id === 'string' ? stored.id : '';
  const name = typeof stored.name === 'string' ? stored.name : '';
  const fresh = newState(id, name, type);
  const initial = stored.initial;
  const mark = stored.preset === true ? { preset: true as const } : {};
  switch (fresh.type) {
    case 'boolean':
      return { ...fresh, initial: initial === true || initial === 'true', ...mark };
    case 'number': {
      const number = typeof initial === 'number' ? initial : Number(initial);
      return { ...fresh, initial: Number.isFinite(number) && typeof initial !== 'boolean' ? number : 0, ...mark };
    }
    case 'choice': {
      const first = typeof initial === 'string' && initial.trim() !== '' ? initial.trim() : String(initial ?? '');
      if (first && first !== 'first') return { ...fresh, initial: first, options: [first, 'second'], ...mark };
      return { ...fresh, ...mark };
    }
    case 'text':
      return { ...fresh, initial: typeof initial === 'string' ? initial : initial === undefined ? '' : String(initial), ...mark };
  }
}

/** A list of options as a person types it: comma separated, trimmed, empties dropped. */
export function optionsFromText(text: string): string[] {
  return text.split(',').map((option) => option.trim()).filter((option) => option !== '');
}

/** A list of key chords as a person types it, comma separated. Null when one of them is no key. */
export function keysFromText(text: string): { keys: string[] } | { error: string } {
  const keys = text.split(',').map((key) => key.trim()).filter((key) => key !== '');
  const wrong = keys.find((key) => keyOfChord(key) === null);
  if (wrong !== undefined) return { error: `${wrong} is not a key. Use a name such as Enter, Escape, ArrowDown, or one character.` };
  return { keys };
}

// --- actions -------------------------------------------------------------------------

/** Each verb the panel offers a picker for, with the words it reads as. */
export const VERBS: readonly { verb: string; label: string }[] = [
  { verb: 'set', label: 'Set a value' },
  { verb: 'toggle', label: 'Toggle a value' },
  { verb: 'step', label: 'Step a value' },
  { verb: 'focus', label: 'Move focus' },
  { verb: 'scroll', label: 'Scroll to' },
  { verb: 'dialog', label: 'Open or close a dialog' },
  { verb: 'popover', label: 'Show or hide a popover' },
  { verb: 'details', label: 'Open or close a disclosure' },
  { verb: 'media', label: 'Play or pause media' },
  { verb: 'fullscreen', label: 'Full screen' },
  { verb: 'pictureInPicture', label: 'Picture in picture' },
  { verb: 'form', label: 'Reset a form' },
  { verb: 'effect', label: 'Play an appear effect' },
  { verb: 'navigate', label: 'Go to an address' },
  { verb: 'emit', label: 'Send a custom event' },
  { verb: 'cancel', label: 'Cancel a delay' },
  { verb: 'capturePointer', label: 'Capture the pointer' },
];

/** The verb keys the format knows, with the ones that have no picker here (they show and delete). */
const ALL_VERB_KEYS = [
  'set', 'toggle', 'step', 'focus', 'rove', 'dialog', 'popover', 'details', 'media', 'fullscreen', 'pictureInPicture',
  'capturePointer', 'scroll', 'form', 'setProp', 'filter', 'delay', 'cancel', 'emit', 'navigate', 'effect',
];

/** Which verb a stored action is, or null when it is none the format knows. */
export function verbOf(action: unknown): string | null {
  if (!isRecord(action)) return null;
  return ALL_VERB_KEYS.find((verb) => Object.hasOwn(action, verb)) ?? null;
}

export const hasPicker = (verb: string | null): boolean => verb !== null && VERBS.some((entry) => entry.verb === verb);

/** The operations each native verb takes, with their words. */
export const VERB_OPS: Readonly<Record<string, readonly { op: string; label: string }[]>> = {
  dialog: [
    { op: 'showModal', label: 'Open as a modal' },
    { op: 'show', label: 'Open' },
    { op: 'close', label: 'Close' },
    { op: 'toggle', label: 'Open or close' },
  ],
  popover: [
    { op: 'show', label: 'Show' },
    { op: 'hide', label: 'Hide' },
    { op: 'toggle', label: 'Show or hide' },
  ],
  details: [
    { op: 'open', label: 'Open' },
    { op: 'close', label: 'Close' },
    { op: 'toggle', label: 'Open or close' },
  ],
  media: [
    { op: 'play', label: 'Play' },
    { op: 'pause', label: 'Pause' },
    { op: 'load', label: 'Load again' },
    { op: 'seek', label: 'Jump to a second' },
    { op: 'rate', label: 'Set the speed' },
    { op: 'volume', label: 'Set the volume' },
  ],
  fullscreen: [
    { op: 'enter', label: 'Enter' },
    { op: 'leave', label: 'Leave' },
  ],
  pictureInPicture: [
    { op: 'enter', label: 'Enter' },
    { op: 'leave', label: 'Leave' },
  ],
};

/** Media operations that carry a number. */
export const MEDIA_VALUE_OPS: ReadonlySet<string> = new Set(['seek', 'rate', 'volume']);

/** What a verb starts as when picked: the first value or node that suits it. */
export function defaultAction(verb: string, context: { states: readonly StateValue[]; selfId: string }): StoredRecord {
  const first = (types: readonly StateType[]) => context.states.find((state) => types.includes(state.type));
  switch (verb) {
    case 'set': {
      const state = context.states[0];
      return { set: state?.id ?? '', value: state ? state.initial : true };
    }
    case 'toggle':
      return { toggle: first(['boolean'])?.id ?? '' };
    case 'step':
      return { step: first(['number', 'choice'])?.id ?? '' };
    case 'dialog':
    case 'popover':
    case 'details':
    case 'media':
    case 'fullscreen':
    case 'pictureInPicture':
      return { [verb]: context.selfId, op: VERB_OPS[verb][0].op };
    case 'form':
      return { form: context.selfId, op: 'reset' };
    case 'navigate':
      return { navigate: '/' };
    case 'emit':
      return { emit: 'open' };
    case 'cancel':
      return { cancel: 'later' };
    case 'capturePointer':
      return { capturePointer: true };
    default:
      return { [verb]: context.selfId };
  }
}

/** The first action a new interaction holds: toggling a value when one can be toggled. */
export function firstAction(context: { states: readonly StateValue[]; selfId: string }): StoredRecord {
  if (context.states.some((state) => state.type === 'boolean')) return defaultAction('toggle', context);
  if (context.states.length > 0) return defaultAction('set', context);
  return defaultAction('focus', context);
}

// --- reading it as words ----------------------------------------------------------------

export interface Names {
  state: (id: string) => string;
  node: (id: string) => string;
}

const literalText = (value: unknown): string => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? String(value));

/** One action as a person reads it: "toggle Menu open", "set Tab to 2". */
export function describeAction(action: unknown, names: Names): string {
  const verb = verbOf(action);
  if (!verb || !isRecord(action)) return 'an action the format does not know';
  const target = action[verb];
  const ref = typeof target === 'string' ? target : '';
  switch (verb) {
    case 'set':
      return isRecord(action.value) ? `set ${names.state(ref)} from an expression` : `set ${names.state(ref)} to ${literalText(action.value)}`;
    case 'toggle':
      return `toggle ${names.state(ref)}`;
    case 'step':
      return `step ${names.state(ref)}${typeof action.by === 'number' && action.by !== 1 ? ` by ${action.by}` : ''}`;
    case 'focus':
      return `focus ${names.node(ref)}`;
    case 'scroll':
      return `scroll to ${names.node(ref)}`;
    case 'rove':
      return `move through ${names.node(ref)} (${String(action.move)})`;
    case 'capturePointer':
      return 'capture the pointer';
    case 'setProp':
      return `write ${String(action.prop)} of ${names.node(ref)}`;
    case 'filter':
      return `filter ${names.node(ref)}`;
    case 'delay':
      return `after ${String(action.delay)} ms, ${Array.isArray(action.do) ? action.do.map((inner) => describeAction(inner, names)).join(', then ') : 'nothing'}`;
    case 'cancel':
      return `cancel the delay ${String(target)}`;
    case 'emit':
      return `send ${String(target)}`;
    case 'navigate':
      return `go to ${String(target)}`;
    case 'effect':
      return `play the appear effect of ${names.node(ref)}`;
    case 'form':
      return `reset ${names.node(ref)}`;
    default: {
      const op = VERB_OPS[verb]?.find((entry) => entry.op === action.op)?.label.toLowerCase() ?? String(action.op);
      const noun = verb === 'pictureInPicture' ? 'picture in picture of' : verb === 'fullscreen' ? 'full screen of' : '';
      return `${op} ${noun ? `${noun} ` : ''}${names.node(ref)}`;
    }
  }
}

/** One trigger as a sentence: "On click, toggle Menu open". */
export function describeTrigger(trigger: unknown, names: Names): string {
  if (!isRecord(trigger)) return 'An entry that is not an interaction';
  const keys = Array.isArray(trigger.keys) && trigger.keys.length > 0 ? ` (${trigger.keys.map(String).join(', ')})` : '';
  const every = trigger.on === 'every' && typeof trigger.ms === 'number' ? ` ${trigger.ms / 1000} s` : '';
  const actions = Array.isArray(trigger.do) && trigger.do.length > 0
    ? trigger.do.map((action) => describeAction(action, names)).join(', then ')
    : 'do nothing';
  return `On ${eventLabel(trigger.on)}${keys}${every}, ${actions}`;
}

/** A condition as words: "Menu open is true". */
export function describeCondition(condition: unknown, names: Pick<Names, 'state'>): string {
  if (!isRecord(condition)) return 'a condition the format does not know';
  if (typeof condition.state === 'string') {
    const eq = isRecord(condition.eq) ? 'the row' : literalText(condition.eq);
    return `${names.state(condition.state)} is ${eq}`;
  }
  if (isRecord(condition.not)) return `not (${describeCondition(condition.not, names)})`;
  if (Array.isArray(condition.all)) return condition.all.map((entry) => describeCondition(entry, names)).join(' and ');
  if (Array.isArray(condition.any)) return condition.any.map((entry) => describeCondition(entry, names)).join(' or ');
  return 'a condition the format does not know';
}

/** True when a show-when is one comparison the panel's two pickers can edit. */
export const isPlainCondition = (condition: unknown): condition is { state: string; eq: string | number | boolean } =>
  isRecord(condition) && typeof condition.state === 'string' && ['string', 'number', 'boolean'].includes(typeof condition.eq)
  && Object.keys(condition).length === 2;
