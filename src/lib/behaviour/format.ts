// src/lib/behaviour/format.ts
//
// The stored form of behaviour, `props.behaviour`, and the one parser that decides
// whether any of it may run. See docs/plans/2026-11-02-behaviour-model.md.
//
// A node stores state, triggers, bindings, a focus group and a visibility condition
// as data. Nothing here is code: expressions are a closed JSON form, actions are a
// closed list, and no string is ever evaluated. Save and publish keep a page as
// opaque JSON, so nothing can be assumed to have been checked when it was written.
// `parseBehaviour` runs at render, in the panel, in the AI validator and in the
// import, and its refusals are the security boundary. What it returns is rebuilt
// from the fields it knows, so an unknown key cannot travel past it.
//
// Refused means dropped whole: one trigger, binding or state value that does not
// parse is set aside with its reason, and the rest of the node stands. An action is
// never dropped from a trigger, because a sequence with a hole does something the
// author never wrote. A `showWhen` that fails leaves the node visible.
//
// What a refusal protects:
//
//   - What a visitor types. The taint rule: `{ event: 'value' }`, `{ event: 'key' }`,
//     `{ active }` and anything read from `text` state may flow only into `text`
//     state, a `text` binding and `filter`, and it is tracked through every operator.
//     An active item's text counts because `filter` decides which items can become
//     active. A trigger that fires per keystroke may only do what repeating leaves
//     unchanged, so how much was typed reaches no reflected state either. This limits
//     behaviour, it is not a guarantee about the page: `filter` makes visibility
//     depend on typed text, and an author who also holds CSS can read that through
//     the selector contract's residual route. Only a Content Security Policy on
//     published pages closes that.
//   - The keyboard. Focus verbs run only from a press, never around Tab or from an
//     unfiltered key trigger, and `prevent` is refused on Tab, Escape, `cancel` and
//     any key trigger without keys, so a stored page cannot hold focus.
//   - The visitor's next page. `navigate` holds a checked literal and needs a press.
//   - The islands. Forms, commerce and the sticky bar own their markup and state.
//   - The tab. Every list has a cap, and `every` and `delay` have floors. The caps do
//     not bound the work on their own: the runtime keeps a budget too.
//
// PURE and client-safe: no React, no MST, no new dependency.

import { isSafeHref } from '@/lib/links/safeHref';
import { BLOCKED_TAGS } from '@/lib/renderer/blockedNodes';
import { TEXT_NODE_TYPE, isTextNodeType } from '@/lib/renderer/textNode';
import { formKindOf } from '@/lib/forms/definition';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';

// --- the stored shape -----------------------------------------------------

/** Marks what a preset generated, so adding a tab re-derives only that. */
interface PresetMark {
  preset?: true;
}

export type StateValue = { id: string; name: string } & PresetMark &
  (
    | { type: 'boolean'; initial: boolean }
    | { type: 'number'; initial: number; min?: number; max?: number; step?: number }
    | { type: 'choice'; initial: string; options: string[] }
    | { type: 'text'; initial: string; maxLength?: number }
  );

export type Literal = string | number | boolean;

export type Expression =
  | Literal
  | { get: string }
  | { eq: [Expression, Expression] }
  | { gt: [Expression, Expression] }
  | { lt: [Expression, Expression] }
  | { not: Expression }
  | { and: Expression[] }
  | { or: Expression[] }
  | { add: [Expression, Expression] }
  | { clamp: [Expression, Expression, Expression] }
  | { map: string; cases: Record<string, Expression>; default?: Expression }
  | { event: 'value' | 'key' | 'newState' }
  | { pointer: 'x' | 'y'; of: string; as: 'px' | 'percent' }
  | { active: string }
  | { row: 'index' };

/** A clone's position: the one thing a condition may compare a state with besides a literal. */
export type RowIndex = { row: 'index' };

export type Condition =
  | { state: string; eq: Literal | RowIndex }
  | { not: Condition }
  | { all: Condition[] }
  | { any: Condition[] };

export type Rove =
  | 'next' | 'prev' | 'first' | 'last' | 'up' | 'down' | 'page-up' | 'page-down'
  | 'type' | 'clear' | 'exit-after' | 'exit-before';

export type Action =
  | { set: string; value: Expression }
  | { toggle: string }
  | { step: string; by?: number; wrap?: boolean }
  | { focus: string }
  | { rove: string; move: Rove }
  | { dialog: string; op: 'showModal' | 'show' | 'close' | 'toggle' }
  | { popover: string; op: 'show' | 'hide' | 'toggle' }
  | { details: string; op: 'open' | 'close' | 'toggle' }
  | { media: string; op: 'play' | 'pause' | 'load' | 'seek' | 'rate' | 'volume'; value?: Expression }
  | { fullscreen: string; op: 'enter' | 'leave' }
  | { pictureInPicture: string; op: 'enter' | 'leave' }
  | { capturePointer: true }
  | { scroll: string; block?: 'start' | 'center' | 'end' | 'nearest' }
  | { form: string; op: 'reset' }
  | { setProp: string; prop: 'min' | 'max' | 'value' | 'checked' | 'disabled'; value: Expression }
  | { filter: string; role: string; text: Expression }
  | { delay: number; key?: string; do: Action[] }
  | { cancel: string }
  | { emit: string }
  | { navigate: string }
  | { effect: string };

export interface Trigger extends PresetMark {
  id: string;
  /** A DOM event name, or a pseudo event: view-enter, view-leave, page-ready, every, custom:<name>. */
  on: string;
  /** Hears the whole page, for Escape on a hover-only tooltip. */
  scope?: 'document';
  /** 'ArrowRight', 'InlineEnd', 'Ctrl+End', 'Printable'. */
  keys?: string[];
  if?: Condition | Expression;
  prevent?: boolean;
  /** For `every`. */
  ms?: number;
  do: Action[];
}

export type Binding = PresetMark &
  (
    | { attr: string; from: Expression }
    | { cssVar: string; from: Expression; unit?: 'px' | '%' | 'rem' }
    | { text: Expression }
  );

export interface FocusGroup {
  /** Which descendants are items. */
  role: string;
  axis: 'line' | 'grid' | 'tree';
  wrap?: boolean;
  /** aria-activedescendant on that node, and the focus stays there. */
  virtual?: { owner: string };
}

/** `props.behaviour`: absent when empty, so a saved page stays unchanged. */
export interface StoredBehaviour {
  state?: StateValue[];
  on?: Trigger[];
  bind?: Binding[];
  group?: FocusGroup;
  showWhen?: Condition;
  noScript?: 'show' | 'hide';
  /** On a preset's root. */
  preset?: { kind: string; version: number };
}

// --- caps -----------------------------------------------------------------

export const MAX_TRIGGERS_PER_NODE = 64;
export const MAX_TRIGGERS_PER_PAGE = 2000;
export const MAX_ACTIONS_PER_TRIGGER = 16;
export const MAX_EXPRESSION_DEPTH = 6;
export const MAX_PROGRAM_BYTES = 64 * 1024;
export const MIN_EVERY_MS = 1000;
export const MIN_DELAY_MS = 16;
export const MAX_DELAY_MS = 10_000;
/** What a browser's timer can hold. Past this it overflows and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_OPTIONS = 64;
const MAX_MAP_CASES = 64;
const MAX_KEYS_PER_TRIGGER = 32;
const MAX_NAME_LENGTH = 128;
const MAX_LITERAL_LENGTH = 1024;
const MAX_TEXT_INITIAL = 4096;

// --- verdicts -------------------------------------------------------------

/** A verdict that says why, because the panel and the import report the reason. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const accept = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** True when `value` holds exactly the required keys, plus any of the optional ones. */
function hasShape(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// --- names ----------------------------------------------------------------

/**
 * A state id becomes an attribute name and a CSS selector, where case does not
 * count, so `s1` and `S1` would be one attribute: lower case only.
 */
const STATE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Never emitted, the same shape as a rule's id. */
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A node's key goes into `[data-fc-n="<key>"]`, so nothing may end that string. */
const NODE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
/** A node's key also keys the program table, so it must not name what every object inherits. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
/** A `custom:<name>` event or a `delay` key. */
const TOKEN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A role goes into `[role="<role>"]`. */
const ROLE = /^[a-z][a-z0-9-]{0,63}$/;
const ARIA_ATTRIBUTE = /^aria-[a-z]+(?:-[a-z]+)*$/;
const DATA_ATTRIBUTE = /^data-u-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CSS_VARIABLE = /^--u-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALUE_ATTRIBUTES: ReadonlySet<string> = new Set(['inert', 'open', 'disabled', 'min', 'max', 'value']);

/**
 * A choice's value reaches `data-fcs-<id>="<value>"` and a `when` selector, so it
 * holds nothing that could end the attribute, the selector or the style element.
 */
function isSafeChoice(text: unknown): text is string {
  return typeof text === 'string' && text.length > 0 && text.length <= MAX_NAME_LENGTH
    && !/[\u0000-\u001f\u007f{}<>;@\\"'`]/.test(text) && !text.includes('/*') && !/url\(/i.test(text);
}

const isName = (text: unknown): text is string =>
  typeof text === 'string' && text.length > 0 && text.length <= MAX_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(text);

/** True when any string below `value` holds a `{{binding}}`. Stops at a depth no parsed entry reaches. */
function holdsBinding(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('{{');
  if (depth > 64 || !value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key.includes('{{') || holdsBinding(child, depth + 1));
}

// --- events ---------------------------------------------------------------

const names = (text: string): ReadonlySet<string> => new Set(text.split(' '));

const POINTER_EVENTS = names(
  'auxclick click contextmenu dblclick mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup '
  + 'pointerdown pointerenter pointerleave pointermove pointerout pointerover pointerup pointercancel '
  + 'gotpointercapture lostpointercapture wheel drag dragstart dragend dragenter dragleave dragover drop',
);
const MEDIA_EVENTS = names(
  'abort canplay canplaythrough durationchange emptied ended loadeddata loadedmetadata loadstart pause play '
  + 'playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange cuechange '
  + 'encrypted waiting waitingforkey',
);
const OPEN_CLOSE_EVENTS = names('toggle beforetoggle close cancel');
const SCROLL_EVENTS = names('scroll scrollend scrollsnapchange scrollsnapchanging');
const FULLSCREEN_EVENTS = names('fullscreenchange fullscreenerror');
const PICTURE_EVENTS = names('enterpictureinpicture leavepictureinpicture');

/** The 100 event rows of the contract, plus `focusin` and `focusout`, which a connector writes. */
export const DOM_EVENTS: ReadonlySet<string> = new Set([
  ...POINTER_EVENTS, ...MEDIA_EVENTS, ...OPEN_CLOSE_EVENTS, ...SCROLL_EVENTS, ...FULLSCREEN_EVENTS, ...PICTURE_EVENTS,
  ...names(
    'keydown keyup focus blur focusin focusout input beforeinput change select selectionchange copy cut paste '
    + 'submit reset formdata invalid command beforematch contentvisibilityautostatechange '
    + 'animationstart animationend animationiteration animationcancel '
    + 'transitionrun transitionstart transitionend transitioncancel load error '
    + 'securitypolicyviolation contextlost contextrestored beforexrselect slotchange',
  ),
]);

const PSEUDO_EVENTS: ReadonlySet<string> = new Set(['view-enter', 'view-leave', 'page-ready', 'every']);
const KEY_EVENTS: ReadonlySet<string> = new Set(['keydown', 'keyup']);
/** What a person does on purpose: the only causes of a focus move. */
const INPUT_EVENTS: ReadonlySet<string> = new Set(['click', 'keydown', 'keyup']);
const LEAVING_EVENTS: ReadonlySet<string> = new Set(['blur', 'focusout']);
/** Fire as a person types into a field. `selectionchange` does too, wherever its trigger sits. */
const TYPED_EVENTS: ReadonlySet<string> = new Set(['input', 'beforeinput']);
const CUSTOM_EVENT = /^custom:([a-z0-9][a-z0-9_-]{0,63})$/;

const isDomEvent = (on: string): boolean => DOM_EVENTS.has(on);

/** Each native verb, and the events it causes: a trigger on one of those may not run it. */
const FAMILIES: Readonly<Record<string, ReadonlySet<string>>> = {
  popover: OPEN_CLOSE_EVENTS,
  details: OPEN_CLOSE_EVENTS,
  dialog: OPEN_CLOSE_EVENTS,
  media: MEDIA_EVENTS,
  fullscreen: FULLSCREEN_EVENTS,
  pictureInPicture: PICTURE_EVENTS,
  scroll: SCROLL_EVENTS,
  form: names('reset'),
};

// --- keys -----------------------------------------------------------------

const NAMED_KEYS: ReadonlySet<string> = names(
  'Printable Enter Space Escape Tab Backspace Delete Insert Home End PageUp PageDown '
  + 'ArrowUp ArrowDown ArrowLeft ArrowRight InlineStart InlineEnd '
  + 'F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12',
);
const CHORD = /^((?:(?:Ctrl|Shift|Alt|Meta)\+)*)([\s\S]+)$/u;

/** The key of a chord, without its modifiers, or null when the text is no key at all. */
export function keyOfChord(chord: unknown): string | null {
  if (typeof chord !== 'string') return null;
  const match = CHORD.exec(chord);
  if (!match) return null;
  const [, modifiers, key] = match;
  if (key === 'Printable') return modifiers ? null : key;
  if (NAMED_KEYS.has(key)) return key;
  const single = [...key].length === 1 && !/[\s\p{C}]/u.test(key);
  return single ? key : null;
}

/**
 * True for a chord whose key writes into a text field. The leak the taint rule
 * closes is per character, so Space counts, and so does a chord on a printable key.
 * Exported for the runtime, which checks this again against the event's target.
 */
export function isPrintableChord(chord: string): boolean {
  const key = keyOfChord(chord);
  return key === null || key === 'Printable' || key === 'Space' || !NAMED_KEYS.has(key);
}

// --- what a node is -------------------------------------------------------

/** The six commerce kinds. Mirrors COMMERCE_KINDS in createComponentElement, which holds React. */
const COMMERCE_KINDS: ReadonlySet<string> = new Set([
  'product-list', 'product-detail', 'variant-selector', 'add-to-cart', 'cart-view', 'checkout-button',
]);
const NON_TEXT_FIELD_TYPES: ReadonlySet<string> = new Set(['select', 'checkbox', 'consent']);
const FIXED_INPUT_TYPES: ReadonlySet<string> = new Set(['range', 'checkbox', 'radio']);
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([...FIXED_INPUT_TYPES, 'color', 'button', 'submit', 'reset', 'file']);

/** A node as it is stored or hydrated: all this parser needs of the tree. */
export interface BehaviourNode {
  id?: unknown;
  /** Set by reusable components: placements of one definition share one program entry. */
  classKey?: unknown;
  type?: unknown;
  props?: unknown;
  children?: unknown;
}

/** What a reference to a node may rely on. */
export interface NodeFacts {
  key: string | null;
  /** In lower case, or null when there is no element, or two nodes share the key and differ. */
  tag: string | null;
  /** A form, a form field, a submit button, a commerce kind or the sticky bar: it owns its markup. */
  island: boolean;
  /** A field an island claims: nothing sits on it but `change` on a non-text type. */
  claimedField: boolean;
  nonTextField: boolean;
  /** Its value is a choice among fixed values, so `{ event: 'value' }` is no source. */
  fixedValue: boolean;
  /** A person types into it. */
  textEntry: boolean;
  /** It renders exactly one text child and no element child. */
  oneTextChild: boolean;
  /** It declares a focus group of a readable shape. */
  group: boolean;
}

const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());

/**
 * The stored value of an attribute, or undefined. A browser reads attribute names
 * in any case and keeps the first spelling, and the parser cannot see that order
 * through a renderer, so a second spelling of the name is treated as unknown.
 */
function attributeOf(props: Record<string, unknown>, name: string): { value: unknown; certain: boolean } | undefined {
  const spellings = Object.keys(props).filter((key) => asciiLower(key) === name);
  if (spellings.length === 0) return undefined;
  return { value: props[spellings[0]], certain: spellings.length === 1 && spellings[0] === name };
}

function isOneTextChild(props: Record<string, unknown>, children: unknown): boolean {
  const list = Array.isArray(children) ? children : [];
  const ownText = typeof props.children === 'string' || typeof props.children === 'number';
  if (ownText) return list.length === 0;
  return list.length === 1 && isPlainObject(list[0]) && list[0].type === TEXT_NODE_TYPE;
}

const groupShapeOk = (group: unknown): boolean =>
  isPlainObject(group) && typeof group.role === 'string' && ROLE.test(group.role) && (group.axis === 'line' || group.axis === 'grid' || group.axis === 'tree');

/** The stable key of a node: what `data-fc-n` and the program use. */
export function behaviourNodeKey(node: BehaviourNode): string | null {
  const key = node.classKey ?? node.id;
  return typeof key === 'string' && NODE_KEY.test(key) && !RESERVED_KEYS.has(key) ? key : null;
}

/** What a node is, read from its stored form. `insideIsland` is set under a commerce island or the sticky bar. */
export function nodeFacts(node: BehaviourNode, insideIsland = false): NodeFacts {
  const props = isPlainObject(node.props) ? node.props : {};
  const stored = typeof node.type === 'string' && node.type.length > 0 ? asciiLower(node.type) : null;
  const tag = isTextNodeType(node.type) || (stored !== null && BLOCKED_TAGS.has(stored)) ? null : stored;
  const formKind = formKindOf(props);
  const commerce = typeof props['data-component-kind'] === 'string' && COMMERCE_KINDS.has(props['data-component-kind']);
  const inputType = attributeOf(props, 'type');
  const inputTypeText = inputType?.certain && typeof inputType.value === 'string' ? asciiLower(inputType.value) : undefined;
  const editable = attributeOf(props, 'contenteditable');
  const editableOff = editable === undefined || (editable.certain && (editable.value === false || editable.value === 'false'));
  return {
    key: behaviourNodeKey(node),
    tag,
    island: insideIsland || formKind !== null || commerce || isStickyCta(props),
    claimedField: insideIsland ? !isStickyCta(props) : formKind === 'form-field' || commerce,
    nonTextField: formKind === 'form-field' && typeof props.fieldType === 'string' && NON_TEXT_FIELD_TYPES.has(props.fieldType),
    fixedValue: tag === 'select' || (tag === 'input' && inputTypeText !== undefined && FIXED_INPUT_TYPES.has(inputTypeText)),
    textEntry: !editableOff || tag === 'textarea'
      || (tag === 'input' && !(inputTypeText !== undefined && NON_TEXT_INPUT_TYPES.has(inputTypeText))),
    oneTextChild: isOneTextChild(props, node.children),
    group: isPlainObject(props.behaviour) && groupShapeOk(props.behaviour.group),
  };
}

/** Two nodes sharing a key can be either at render, so only what holds for both counts. */
function mergeFacts(a: NodeFacts, b: NodeFacts): NodeFacts {
  return {
    key: a.key,
    tag: a.tag === b.tag ? a.tag : null,
    island: a.island || b.island,
    claimedField: a.claimedField || b.claimedField,
    nonTextField: a.nonTextField && b.nonTextField,
    fixedValue: a.fixedValue && b.fixedValue,
    textEntry: a.textEntry || b.textEntry,
    oneTextChild: a.oneTextChild && b.oneTextChild,
    group: a.group && b.group,
  };
}

// --- expressions ----------------------------------------------------------

type Kind = 'boolean' | 'number' | 'string' | 'any';

/** An expression as read: rebuilt, with what it yields and whether typed text is in it. */
interface ReadExpression {
  value: Expression;
  kind: Kind;
  tainted: boolean;
}

/** What an expression can see. `event` is absent in a binding, which has no event. */
interface ExpressionScope {
  states: ReadonlyMap<string, StateValue>;
  nodes: ReadonlyMap<string, NodeFacts>;
  self: NodeFacts;
  event?: string;
}

const TAINT_REASON = 'typed text may flow only into text state, a text binding or filter';

const kindOfState = (state: StateValue): Kind =>
  state.type === 'boolean' ? 'boolean' : state.type === 'number' ? 'number' : 'string';

const kindOfLiteral = (value: Literal): Kind => (typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean');

const isNumeric = (read: ReadExpression): boolean => read.kind === 'number' || read.kind === 'any';

function readList(list: unknown, count: number | null, scope: ExpressionScope, depth: number): Parsed<ReadExpression[]> {
  if (!Array.isArray(list) || list.length === 0 || (count !== null && list.length !== count)) {
    return refuse(count === null ? 'this operator takes a list of values' : `this operator takes ${count} values`);
  }
  const reads: ReadExpression[] = [];
  for (const entry of list as unknown[]) {
    const read = readExpression(entry, scope, depth + 1);
    if (!read.ok) return read;
    reads.push(read.value);
  }
  return accept(reads);
}

const anyTainted = (reads: ReadExpression[]): boolean => reads.some((read) => read.tainted);

function readMap(value: Record<string, unknown>, scope: ExpressionScope, depth: number): Parsed<ReadExpression> {
  if (!hasShape(value, ['map', 'cases'], ['default'])) return refuse('a map holds map, cases and default');
  const state = typeof value.map === 'string' ? scope.states.get(value.map) : undefined;
  if (!state) return refuse(`no state ${String(value.map)} is in reach`);
  if (!isPlainObject(value.cases)) return refuse('a map needs cases');
  const entries = Object.entries(value.cases);
  if (entries.length === 0 || entries.length > MAX_MAP_CASES) return refuse(`a map holds 1 to ${MAX_MAP_CASES} cases`);
  const cases: [string, Expression][] = [];
  const reads: ReadExpression[] = [];
  for (const [key, entry] of entries) {
    const read = readExpression(entry, scope, depth + 1);
    if (!read.ok) return read;
    cases.push([key, read.value.value]);
    reads.push(read.value);
  }
  const rebuilt: Extract<Expression, { map: string }> = { map: state.id, cases: Object.fromEntries(cases) };
  if (value.default !== undefined) {
    const read = readExpression(value.default, scope, depth + 1);
    if (!read.ok) return read;
    rebuilt.default = read.value.value;
    reads.push(read.value);
  }
  const kind = reads.every((read) => read.kind === reads[0].kind) ? reads[0].kind : 'any';
  return accept({ value: rebuilt, kind, tainted: state.type === 'text' || anyTainted(reads) });
}

function readEvent(value: Record<string, unknown>, scope: ExpressionScope): Parsed<ReadExpression> {
  if (!hasShape(value, ['event'])) return refuse('an event read holds event alone');
  const { event } = scope;
  if (event === undefined) return refuse('a binding has no event to read');
  if (value.event === 'value') {
    if (!isDomEvent(event)) return refuse(`${event} has no value to read`);
    return accept({ value: { event: 'value' }, kind: 'any', tainted: !scope.self.fixedValue });
  }
  if (value.event === 'key') {
    if (!KEY_EVENTS.has(event)) return refuse(`${event} has no key to read`);
    return accept({ value: { event: 'key' }, kind: 'string', tainted: true });
  }
  if (value.event === 'newState') {
    if (event !== 'toggle' && event !== 'beforetoggle') return refuse(`${event} has no newState to read`);
    return accept({ value: { event: 'newState' }, kind: 'string', tainted: false });
  }
  return refuse(`${String(value.event)} cannot be read from an event`);
}

function readPointer(value: Record<string, unknown>, scope: ExpressionScope): Parsed<ReadExpression> {
  if (!hasShape(value, ['pointer', 'of', 'as'])) return refuse('a pointer read holds pointer, of and as');
  if (scope.event === undefined) return refuse('a binding has no event to read');
  if (!POINTER_EVENTS.has(scope.event)) return refuse(`${scope.event} has no pointer position`);
  if ((value.pointer !== 'x' && value.pointer !== 'y') || (value.as !== 'px' && value.as !== 'percent')) {
    return refuse('a pointer read is x or y, as px or percent');
  }
  const target = referenceTo(value.of, scope);
  if (!target.ok) return target;
  return accept({ value: { pointer: value.pointer, of: target.value.key as string, as: value.as }, kind: 'number', tainted: false });
}

function readActive(value: Record<string, unknown>, scope: ExpressionScope): Parsed<ReadExpression> {
  if (!hasShape(value, ['active'])) return refuse('an active read holds active alone');
  if (scope.event === undefined) return refuse('a binding has no active item to read');
  const target = referenceTo(value.active, scope);
  if (!target.ok) return target;
  if (!target.value.group) return refuse(`${String(value.active)} holds no focus group`);
  // `filter` decides which items can be active, so this text can answer what was typed.
  return accept({ value: { active: target.value.key as string }, kind: 'string', tainted: true });
}

function readOperands(
  value: Record<string, unknown>,
  operator: 'eq' | 'gt' | 'lt' | 'and' | 'or' | 'add' | 'clamp',
  scope: ExpressionScope,
  depth: number,
): Parsed<ReadExpression> {
  if (!hasShape(value, [operator])) return refuse(`${operator} stands alone in its object`);
  const count = operator === 'clamp' ? 3 : operator === 'and' || operator === 'or' ? null : 2;
  const reads = readList(value[operator], count, scope, depth);
  if (!reads.ok) return reads;
  const list = reads.value;
  const numeric = operator === 'gt' || operator === 'lt' || operator === 'add' || operator === 'clamp';
  if (numeric && !list.every(isNumeric)) return refuse(`${operator} works on numbers`);
  const rebuilt = { [operator]: list.map((read) => read.value) } as unknown as Expression;
  const kind: Kind = operator === 'add' || operator === 'clamp' ? 'number' : 'boolean';
  return accept({ value: rebuilt, kind, tainted: anyTainted(list) });
}

/**
 * Read one expression. Total over any input: it rebuilds what it accepts, and depth
 * is checked before it recurses, so a stored chain cannot exhaust the stack.
 */
function readExpression(value: unknown, scope: ExpressionScope, depth = 1): Parsed<ReadExpression> {
  if (typeof value === 'boolean' || isFiniteNumber(value)) return accept({ value, kind: kindOfLiteral(value), tainted: false });
  if (typeof value === 'string') {
    if (value.length > MAX_LITERAL_LENGTH) return refuse('a text value is too long');
    return accept({ value, kind: 'string', tainted: false });
  }
  if (!isPlainObject(value)) return refuse('an expression is a value or one operator');
  if (depth > MAX_EXPRESSION_DEPTH) return refuse(`an expression nests at most ${MAX_EXPRESSION_DEPTH} levels`);

  if ('get' in value) {
    if (!hasShape(value, ['get'])) return refuse('a read holds get alone');
    const state = typeof value.get === 'string' ? scope.states.get(value.get) : undefined;
    if (!state) return refuse(`no state ${String(value.get)} is in reach`);
    return accept({ value: { get: state.id }, kind: kindOfState(state), tainted: state.type === 'text' });
  }
  if ('not' in value) {
    if (!hasShape(value, ['not'])) return refuse('not stands alone in its object');
    const read = readExpression(value.not, scope, depth + 1);
    if (!read.ok) return read;
    return accept({ value: { not: read.value.value }, kind: 'boolean', tainted: read.value.tainted });
  }
  for (const operator of ['eq', 'gt', 'lt', 'and', 'or', 'add', 'clamp'] as const) {
    if (operator in value) return readOperands(value, operator, scope, depth);
  }
  if ('map' in value) return readMap(value, scope, depth);
  if ('event' in value) return readEvent(value, scope);
  if ('pointer' in value) return readPointer(value, scope);
  if ('active' in value) return readActive(value, scope);
  if ('row' in value) {
    if (!hasShape(value, ['row']) || value.row !== 'index') return refuse('a row read is { row: "index" }');
    return accept({ value: { row: 'index' }, kind: 'number', tainted: false });
  }
  return refuse('this is not an expression');
}

/** An expression that may not carry typed text. */
function readClean(value: unknown, scope: ExpressionScope): Parsed<ReadExpression> {
  const read = readExpression(value, scope);
  if (read.ok && read.value.tainted) return refuse(TAINT_REASON);
  return read;
}

// --- conditions -----------------------------------------------------------

/** What a condition can see. `allowRow` is off for a CSS `when`, whose class is shared across rows. */
export interface ConditionScope {
  states: ReadonlyMap<string, StateValue>;
  allowRow?: boolean;
}

function refusedEq(state: StateValue, eq: unknown, allowRow: boolean): string | null {
  if (isPlainObject(eq)) {
    if (!hasShape(eq, ['row']) || eq.row !== 'index') return 'a condition compares with a value or the row index';
    if (!allowRow) return 'the row index cannot reach a stylesheet';
    return state.type === 'number' ? null : 'the row index compares with a number';
  }
  if (state.type === 'boolean') return typeof eq === 'boolean' ? null : `${state.id} is true or false`;
  if (state.type === 'number') return isFiniteNumber(eq) ? null : `${state.id} is a number`;
  if (state.type === 'choice') return typeof eq === 'string' && state.options.includes(eq) ? null : `${String(eq)} is not an option of ${state.id}`;
  return TAINT_REASON;
}

/**
 * One condition, rebuilt or refused. A reference to `text` state is refused, so what
 * a visitor types decides nothing. Exported for the `when` of a selector rule.
 */
export function parseCondition(value: unknown, scope: ConditionScope, depth = 1): Parsed<Condition> {
  if (!isPlainObject(value)) return refuse('a condition is an object');
  if (depth > MAX_EXPRESSION_DEPTH) return refuse(`a condition nests at most ${MAX_EXPRESSION_DEPTH} levels`);
  if ('state' in value) {
    if (!hasShape(value, ['state', 'eq'])) return refuse('a condition holds state and eq');
    const state = typeof value.state === 'string' ? scope.states.get(value.state) : undefined;
    if (!state) return refuse(`no state ${String(value.state)} is in reach`);
    const reason = refusedEq(state, value.eq, scope.allowRow === true);
    if (reason) return refuse(reason);
    return accept({ state: state.id, eq: isPlainObject(value.eq) ? { row: 'index' } : (value.eq as Literal) });
  }
  if ('not' in value) {
    if (!hasShape(value, ['not'])) return refuse('not stands alone in its object');
    const inner = parseCondition(value.not, scope, depth + 1);
    return inner.ok ? accept({ not: inner.value }) : inner;
  }
  const list = 'all' in value ? 'all' : 'any' in value ? 'any' : null;
  if (!list || !hasShape(value, [list])) return refuse('a condition is state, not, all or any');
  const entries = value[list];
  if (!Array.isArray(entries) || entries.length === 0) return refuse(`${list} takes a list of conditions`);
  const parts: Condition[] = [];
  for (const entry of entries as unknown[]) {
    const part = parseCondition(entry, scope, depth + 1);
    if (!part.ok) return part;
    parts.push(part.value);
  }
  return accept(list === 'all' ? { all: parts } : { any: parts });
}

/** An `if`: a condition or a clean expression, told apart by their keys. `not` takes its child's kind. */
function parseIf(value: unknown, scope: ExpressionScope, depth = 1): Parsed<Condition | Expression> {
  if (isPlainObject(value) && ('state' in value || 'all' in value || 'any' in value)) {
    return parseCondition(value, { states: scope.states, allowRow: true }, depth);
  }
  if (isPlainObject(value) && 'not' in value) {
    if (!hasShape(value, ['not'])) return refuse('not stands alone in its object');
    if (depth > MAX_EXPRESSION_DEPTH) return refuse(`a condition nests at most ${MAX_EXPRESSION_DEPTH} levels`);
    const inner = parseIf(value.not, scope, depth + 1);
    return inner.ok ? accept({ not: inner.value } as Condition | Expression) : inner;
  }
  const read = readExpression(value, scope, depth);
  if (!read.ok) return read;
  return read.value.tainted ? refuse(TAINT_REASON) : accept(read.value.value);
}

// --- references -----------------------------------------------------------

function referenceTo(key: unknown, scope: ExpressionScope): Parsed<NodeFacts & { key: string }> {
  if (typeof key !== 'string' || !NODE_KEY.test(key)) return refuse('a target is a node id');
  // The tree's record first: it holds what every node sharing this key is.
  const facts = scope.nodes.get(key) ?? (scope.self.key === key ? scope.self : undefined);
  if (!facts) return refuse(`no node ${key} exists`);
  if (facts.tag === null) return refuse(`${key} has no single element to act on`);
  return accept({ ...facts, key });
}

// --- actions --------------------------------------------------------------

/** The head of a trigger, already read, plus where in it this action stands. */
interface ActionScope extends ExpressionScope {
  on: string;
  keys?: string[];
  underDelay: boolean;
  /** This trigger fires per keystroke, so nothing here may build up across firings. */
  typing: boolean;
  /** Actions counted so far in this trigger, nested ones too. */
  used: { count: number };
}

const OPS: Readonly<Record<string, readonly string[]>> = {
  dialog: ['showModal', 'show', 'close', 'toggle'],
  popover: ['show', 'hide', 'toggle'],
  details: ['open', 'close', 'toggle'],
  fullscreen: ['enter', 'leave'],
  pictureInPicture: ['enter', 'leave'],
};
/** The element a verb needs, when it needs one. */
const VERB_TAGS: Readonly<Record<string, readonly string[]>> = {
  dialog: ['dialog'],
  details: ['details'],
  media: ['audio', 'video'],
  pictureInPicture: ['video'],
  form: ['form'],
};
const MEDIA_OPS: readonly string[] = ['play', 'pause', 'load', 'seek', 'rate', 'volume'];
const MEDIA_VALUE_OPS: readonly string[] = ['seek', 'rate', 'volume'];
const ROVE_MOVES: readonly string[] = [
  'next', 'prev', 'first', 'last', 'up', 'down', 'page-up', 'page-down', 'type', 'clear', 'exit-after', 'exit-before',
];
const SET_PROPS: readonly string[] = ['min', 'max', 'value', 'checked', 'disabled'];
const SCROLL_BLOCKS: readonly string[] = ['start', 'center', 'end', 'nearest'];
/** An island may be focused, scrolled to or revealed: nothing here changes what it owns. */
const ISLAND_SAFE_VERBS: ReadonlySet<string> = new Set(['focus', 'scroll', 'effect']);

const VERBS = [
  'set', 'toggle', 'step', 'focus', 'rove', 'dialog', 'popover', 'details', 'media', 'fullscreen', 'pictureInPicture',
  'capturePointer', 'scroll', 'form', 'setProp', 'filter', 'delay', 'cancel', 'emit', 'navigate', 'effect',
] as const;
type Verb = (typeof VERBS)[number];

/** Why the family rule refuses this verb in this trigger, or null. */
function refusedFamily(verb: Verb, on: string): string | null {
  const family = Object.hasOwn(FAMILIES, verb) ? FAMILIES[verb] : undefined;
  return family?.has(on) ? `${verb} in a ${on} trigger would cause its own event` : null;
}

/** True for a key trigger that fires on Tab, by name or by having no keys. */
function firesOnTab(scope: ActionScope): boolean {
  if (!KEY_EVENTS.has(scope.on)) return false;
  return !scope.keys || scope.keys.some((chord) => keyOfChord(chord) === 'Tab');
}

/** Why a verb that moves focus may not run here, or null. A focus move needs a press, and never answers Tab. */
function refusedFocusMove(verb: string, scope: ActionScope, extraEvents: readonly string[] = []): string | null {
  if (LEAVING_EVENTS.has(scope.on)) return `${verb} in a ${scope.on} trigger could hold focus`;
  if (!INPUT_EVENTS.has(scope.on) && !extraEvents.includes(scope.on)) return `${verb} runs only from a press, not from ${scope.on}`;
  return firesOnTab(scope) ? `${verb} answering Tab could hold focus` : null;
}

const TYPING_REASON = 'this trigger fires per keystroke, so only what repeating leaves unchanged may run: a count of what was typed would reach reflected state';

/**
 * Why this verb may not run per keystroke, or null. A closed list of what repeating
 * leaves unchanged, because the rest builds up: `step`, `toggle` and a `set` reading
 * state count, `emit` and `delay` carry the count to another trigger, a native toggle
 * comes back through `newState`, and any `rove` but `clear` moves an index.
 */
function refusedWhileTyping(verb: Verb, action: Record<string, unknown>, scope: ActionScope): string | null {
  if (!scope.typing || verb === 'filter') return null;
  if (verb === 'rove') return action.move === 'clear' ? null : TYPING_REASON;
  if (verb !== 'set') return TYPING_REASON;
  const state = typeof action.set === 'string' ? scope.states.get(action.set) : undefined;
  return state?.type === 'text' || typeof action.value !== 'object' ? null : TYPING_REASON;
}

function targetOf(verb: Verb, key: unknown, scope: ActionScope): Parsed<NodeFacts & { key: string }> {
  const target = referenceTo(key, scope);
  if (!target.ok) return target;
  if (target.value.island && !ISLAND_SAFE_VERBS.has(verb)) return refuse(`${verb} cannot change ${target.value.key}: an island owns its markup`);
  const tags = Object.hasOwn(VERB_TAGS, verb) ? VERB_TAGS[verb] : undefined;
  if (tags && !tags.includes(target.value.tag as string)) return refuse(`${verb} needs a ${tags.join(' or ')} element`);
  return target;
}

function stateOf(key: unknown, scope: ExpressionScope): Parsed<StateValue> {
  if (typeof key !== 'string') return refuse('a state reference is an id');
  const state = scope.states.get(key);
  return state ? accept(state) : refuse(`no state ${key} is in reach`);
}

/**
 * Why a value may not be written into a choice state, or null. Every leaf the parser
 * can see is checked against the options: a literal must be one, a read of another
 * choice must hold only options of this one, and a map is checked through its cases
 * and default. An event value only exists at run time, so the runtime must keep a
 * choice inside its options.
 */
function choiceRefusal(expr: Expression, id: string, options: readonly string[], states: ReadonlyMap<string, StateValue>): string | null {
  if (typeof expr === 'string') return options.includes(expr) ? null : `${expr} is not an option of ${id}`;
  if (typeof expr !== 'object') return `${id} does not hold a ${typeof expr}`;
  if ('get' in expr) {
    const source = states.get(expr.get);
    if (source?.type !== 'choice') return null;
    const stray = source.options.find((option) => !options.includes(option));
    return stray === undefined ? null : `${stray} of ${source.id} is not an option of ${id}`;
  }
  if ('map' in expr) {
    const branches = [...Object.values(expr.cases), ...(expr.default !== undefined ? [expr.default] : [])];
    for (const branch of branches) {
      const reason = choiceRefusal(branch, id, options, states);
      if (reason) return reason;
    }
    return null;
  }
  return 'event' in expr ? null : `${id} does not hold a number or a boolean`;
}

function parseSet(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['set', 'value'])) return refuse('set holds set and value');
  const state = stateOf(action.set, scope);
  if (!state.ok) return state;
  const read = readExpression(action.value, scope);
  if (!read.ok) return read;
  if (read.value.tainted && state.value.type !== 'text') return refuse(TAINT_REASON);
  const expected = kindOfState(state.value);
  if (read.value.kind !== 'any' && read.value.kind !== expected) return refuse(`${state.value.id} does not hold a ${read.value.kind}`);
  if (state.value.type === 'choice') {
    const reason = choiceRefusal(read.value.value, state.value.id, state.value.options, scope.states);
    if (reason) return refuse(reason);
  }
  return accept({ set: state.value.id, value: read.value.value });
}

function parseStep(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['step'], ['by', 'wrap'])) return refuse('step holds step, by and wrap');
  const state = stateOf(action.step, scope);
  if (!state.ok) return state;
  if (state.value.type !== 'number' && state.value.type !== 'choice') return refuse('step moves a number or a choice');
  if (action.by !== undefined && (!isFiniteNumber(action.by) || action.by === 0)) return refuse('by is a number other than 0');
  if (action.wrap !== undefined && typeof action.wrap !== 'boolean') return refuse('wrap is true or false');
  return accept({
    step: state.value.id,
    ...(action.by !== undefined ? { by: action.by } : {}),
    ...(action.wrap !== undefined ? { wrap: action.wrap } : {}),
  });
}

function parseRove(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['rove', 'move'])) return refuse('rove holds rove and move');
  if (typeof action.move !== 'string' || !ROVE_MOVES.includes(action.move)) return refuse(`${String(action.move)} is not a move`);
  const target = targetOf('rove', action.rove, scope);
  if (!target.ok) return target;
  if (!target.value.group) return refuse(`${target.value.key} holds no focus group`);
  // `clear` drops a virtual group's active item as a person types: it moves no focus.
  const reason = action.move === 'clear' && !LEAVING_EVENTS.has(scope.on) ? null : refusedFocusMove('rove', scope);
  if (reason) return refuse(reason);
  if (action.move === 'type' && !scope.keys) return refuse('typeahead needs a trigger with keys');
  return accept({ rove: target.value.key, move: action.move as Rove });
}

function parseOpen(verb: 'dialog' | 'popover' | 'details' | 'fullscreen' | 'pictureInPicture', action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, [verb, 'op'])) return refuse(`${verb} holds ${verb} and op`);
  if (typeof action.op !== 'string' || !OPS[verb].includes(action.op)) return refuse(`${String(action.op)} is not an operation of ${verb}`);
  const target = targetOf(verb, action[verb], scope);
  if (!target.ok) return target;
  // Each of these can open the element, which runs its focusing steps and takes the
  // keyboard to an `autofocus` child. Stored or client rendered content can hold that
  // child, so it cannot be ruled out per target, and each counts as a focus move.
  if ((verb === 'dialog' && action.op !== 'close') || (verb === 'popover' && action.op !== 'hide')) {
    const reason = refusedFocusMove(`${verb} ${action.op}`, scope, action.op === 'showModal' ? ['page-ready', 'view-enter'] : []);
    if (reason) return refuse(reason);
  }
  return accept({ [verb]: target.value.key, op: action.op } as Action);
}

function parseMedia(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['media', 'op'], ['value'])) return refuse('media holds media, op and value');
  if (typeof action.op !== 'string' || !MEDIA_OPS.includes(action.op)) return refuse(`${String(action.op)} is not an operation of media`);
  const target = targetOf('media', action.media, scope);
  if (!target.ok) return target;
  const op = action.op as 'play' | 'pause' | 'load' | 'seek' | 'rate' | 'volume';
  if (!MEDIA_VALUE_OPS.includes(op)) {
    return action.value === undefined ? accept({ media: target.value.key, op }) : refuse(`${op} takes no value`);
  }
  const read = readClean(action.value, scope);
  if (!read.ok) return read;
  if (!isNumeric(read.value)) return refuse(`${op} takes a number`);
  return accept({ media: target.value.key, op, value: read.value.value });
}

function parseScroll(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['scroll'], ['block'])) return refuse('scroll holds scroll and block');
  const target = targetOf('scroll', action.scroll, scope);
  if (!target.ok) return target;
  if (action.block === undefined) return accept({ scroll: target.value.key });
  if (typeof action.block !== 'string' || !SCROLL_BLOCKS.includes(action.block)) return refuse('block is start, center, end or nearest');
  return accept({ scroll: target.value.key, block: action.block as 'start' });
}

function parseForm(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['form', 'op'])) return refuse('form holds form and op');
  if (action.op !== 'reset') return refuse('there is no submit action: form keeps reset only');
  const target = targetOf('form', action.form, scope);
  return target.ok ? accept({ form: target.value.key, op: 'reset' }) : target;
}

function parseSetProp(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['setProp', 'prop', 'value'])) return refuse('setProp holds setProp, prop and value');
  if (typeof action.prop !== 'string' || !SET_PROPS.includes(action.prop)) return refuse(`${String(action.prop)} cannot be written`);
  const target = targetOf('setProp', action.setProp, scope);
  if (!target.ok) return target;
  // Enter copying an option into the field it was typed into: a property, which no
  // selector reads, on a control that already holds typed text.
  const copiesItem = action.prop === 'value' && target.value.textEntry && isPlainObject(action.value) && 'active' in action.value;
  const read = copiesItem ? readExpression(action.value, scope) : readClean(action.value, scope);
  if (!read.ok) return read;
  return accept({ setProp: target.value.key, prop: action.prop as 'value', value: read.value.value });
}

function parseFilter(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['filter', 'role', 'text'])) return refuse('filter holds filter, role and text');
  if (typeof action.role !== 'string' || !ROLE.test(action.role)) return refuse('filter needs a role');
  const target = targetOf('filter', action.filter, scope);
  if (!target.ok) return target;
  const read = readExpression(action.text, scope);
  if (!read.ok) return read;
  return accept({ filter: target.value.key, role: action.role, text: read.value.value });
}

function parseDelay(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['delay', 'do'], ['key'])) return refuse('delay holds delay, do and key');
  if (!isFiniteNumber(action.delay) || action.delay < MIN_DELAY_MS || action.delay > MAX_DELAY_MS) {
    return refuse(`a delay runs ${MIN_DELAY_MS} ms to ${MAX_DELAY_MS} ms later`);
  }
  if (action.key !== undefined && (typeof action.key !== 'string' || !TOKEN.test(action.key))) return refuse('a delay key is a short name');
  const list = parseActions(action.do, { ...scope, underDelay: true });
  if (!list.ok) return list;
  return accept({ delay: action.delay, ...(action.key !== undefined ? { key: action.key } : {}), do: list.value });
}

/** True when this trigger is a press on a link-like control. */
function isPressTrigger(scope: ActionScope): boolean {
  if (scope.on === 'click' || scope.on === 'submit') return true;
  return scope.on === 'keydown' && !!scope.keys && scope.keys.every((chord) => chord === 'Enter' || chord === 'Space');
}

function parseNavigate(action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  if (!hasShape(action, ['navigate'])) return refuse('navigate holds an address alone');
  if (scope.underDelay) return refuse('navigate cannot wait: by then it is no longer a press');
  if (!isPressTrigger(scope)) return refuse('navigate runs only from click, submit, or keydown with Enter or Space');
  const href = action.navigate;
  if (typeof href !== 'string' || href !== href.trim() || !isSafeHref(href)) return refuse('navigate needs a safe literal address');
  return accept({ navigate: href });
}

/** True for an address that leaves the site, which the runtime checks against user activation. */
export function leavesSite(href: string): boolean {
  return !(href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//')));
}

function parseAction(action: unknown, scope: ActionScope): Parsed<Action> {
  if (!isPlainObject(action)) return refuse('an action is an object');
  const verb = VERBS.find((name) => Object.hasOwn(action, name));
  if (!verb) return refuse(`${Object.keys(action)[0] ?? 'this'} is not an action`);
  scope.used.count += 1;
  if (scope.used.count > MAX_ACTIONS_PER_TRIGGER) return refuse(`a trigger runs at most ${MAX_ACTIONS_PER_TRIGGER} actions`);
  const family = refusedFamily(verb, scope.on);
  if (family) return refuse(family);
  const parsed = parseVerb(verb, action, scope);
  if (!parsed.ok) return parsed;
  const typing = refusedWhileTyping(verb, action, scope);
  return typing ? refuse(typing) : parsed;
}

function parseVerb(verb: Verb, action: Record<string, unknown>, scope: ActionScope): Parsed<Action> {
  switch (verb) {
    case 'set': return parseSet(action, scope);
    case 'step': return parseStep(action, scope);
    case 'rove': return parseRove(action, scope);
    case 'dialog':
    case 'popover':
    case 'details':
    case 'fullscreen':
    case 'pictureInPicture': return parseOpen(verb, action, scope);
    case 'media': return parseMedia(action, scope);
    case 'scroll': return parseScroll(action, scope);
    case 'form': return parseForm(action, scope);
    case 'setProp': return parseSetProp(action, scope);
    case 'filter': return parseFilter(action, scope);
    case 'delay': return parseDelay(action, scope);
    case 'navigate': return parseNavigate(action, scope);
    case 'toggle': {
      if (!hasShape(action, ['toggle'])) return refuse('toggle holds a state alone');
      const state = stateOf(action.toggle, scope);
      if (!state.ok) return state;
      return state.value.type === 'boolean' ? accept({ toggle: state.value.id }) : refuse('toggle flips a boolean');
    }
    case 'focus': {
      if (!hasShape(action, ['focus'])) return refuse('focus holds a target alone');
      const reason = refusedFocusMove('focus', scope);
      if (reason) return refuse(reason);
      const target = targetOf('focus', action.focus, scope);
      return target.ok ? accept({ focus: target.value.key }) : target;
    }
    case 'capturePointer': {
      if (!hasShape(action, ['capturePointer']) || action.capturePointer !== true) return refuse('capturePointer is true');
      if (scope.on !== 'pointerdown' || scope.underDelay) return refuse('capturePointer runs directly from pointerdown');
      return accept({ capturePointer: true });
    }
    case 'cancel':
    case 'emit': {
      if (!hasShape(action, [verb])) return refuse(`${verb} holds a name alone`);
      const name = action[verb];
      if (typeof name !== 'string' || !TOKEN.test(name)) return refuse(`${verb} needs a short name`);
      return accept({ [verb]: name } as Action);
    }
    case 'effect': {
      if (!hasShape(action, ['effect'])) return refuse('effect holds a target alone');
      const target = targetOf('effect', action.effect, scope);
      return target.ok ? accept({ effect: target.value.key }) : target;
    }
  }
}

function parseActions(list: unknown, scope: ActionScope): Parsed<Action[]> {
  if (!Array.isArray(list) || list.length === 0) return refuse('a trigger needs a list of actions');
  if (list.length > MAX_ACTIONS_PER_TRIGGER) return refuse(`a trigger runs at most ${MAX_ACTIONS_PER_TRIGGER} actions`);
  const actions: Action[] = [];
  for (const entry of list as unknown[]) {
    const action = parseAction(entry, scope);
    if (!action.ok) return action;
    actions.push(action.value);
  }
  return accept(actions);
}

// --- triggers -------------------------------------------------------------

const TRIGGER_KEYS = ['id', 'on', 'scope', 'keys', 'if', 'prevent', 'ms', 'do', 'preset'];

/** Why this `on` is not one the format knows, or null. */
function refusedOn(on: unknown): string | null {
  if (typeof on !== 'string') return 'a trigger needs an event name';
  return isDomEvent(on) || PSEUDO_EVENTS.has(on) || CUSTOM_EVENT.test(on) ? null : `${on} is not an event`;
}

/** Why these keys are refused, or null. */
function refusedKeys(trigger: Record<string, unknown>, on: string, self: NodeFacts): string | null {
  const { keys, scope } = trigger;
  if (keys !== undefined) {
    if (!KEY_EVENTS.has(on)) return 'keys belong to keydown and keyup';
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS_PER_TRIGGER) return `keys is a list of 1 to ${MAX_KEYS_PER_TRIGGER} keys`;
    for (const chord of keys as unknown[]) {
      if (keyOfChord(chord) === null) return `${String(chord)} is not a key`;
    }
  }
  if (!KEY_EVENTS.has(on)) return null;
  const printable = (keys as string[] | undefined)?.some(isPrintableChord) ?? true;
  if (scope === 'document' && printable) return 'a document trigger may name only non-printable keys';
  if (self.textEntry && printable) return 'a printable key never matches on a text entry control';
  return null;
}

/** Why `prevent` is refused here, or null. */
function refusedPrevent(trigger: Record<string, unknown>, on: string): string | null {
  if (trigger.prevent === undefined || trigger.prevent === false) return null;
  if (trigger.prevent !== true) return 'prevent is true or false';
  if (!isDomEvent(on)) return `${on} has no default to prevent`;
  if (on === 'cancel') return 'prevent on cancel would keep a dialog open against Escape';
  if (on === 'keydown' && trigger.keys === undefined) return 'prevent needs keys, or it would swallow every key';
  const held = ((trigger.keys as string[] | undefined) ?? []).find((chord) => {
    const key = keyOfChord(chord);
    return key === 'Tab' || key === 'Escape';
  });
  return held ? `prevent on ${held} would hold the keyboard` : null;
}

/** Why a trigger may not sit on this node, or null. */
function refusedPlacement(on: string, self: NodeFacts): string | null {
  if (!self.claimedField) return null;
  return on === 'change' && self.nonTextField ? null : 'an island claims this field: only change on a non-text type may sit on it';
}

function parseTrigger(entry: unknown, base: ExpressionScope): Parsed<Trigger> {
  if (!isPlainObject(entry)) return refuse('a trigger is an object');
  if (!hasShape(entry, ['id', 'on', 'do'], TRIGGER_KEYS)) return refuse('a trigger holds id, on and do, and the listed options');
  if (typeof entry.id !== 'string' || !ENTRY_ID.test(entry.id)) return refuse('a trigger needs a short id');
  const refusedName = refusedOn(entry.on);
  if (refusedName) return refuse(refusedName);
  const on = entry.on as string;
  if (entry.scope !== undefined && entry.scope !== 'document') return refuse('scope is document');
  if (entry.scope === 'document' && !isDomEvent(on)) return refuse(`${on} is not a document event`);
  if (entry.preset !== undefined && entry.preset !== true) return refuse('preset marks an entry with true');

  const reason = refusedKeys(entry, on, base.self) ?? refusedPrevent(entry, on) ?? refusedPlacement(on, base.self);
  if (reason) return refuse(reason);

  if (on === 'every') {
    if (!isFiniteNumber(entry.ms) || entry.ms < MIN_EVERY_MS || entry.ms > MAX_TIMER_MS) return refuse(`every needs ms of at least ${MIN_EVERY_MS}`);
  } else if (entry.ms !== undefined) {
    return refuse('ms belongs to every');
  }

  // A fixed-value control hears only itself, unless the trigger hears the whole page.
  const typing = on === 'selectionchange' || (TYPED_EVENTS.has(on) && (!base.self.fixedValue || entry.scope === 'document'));
  const scope: ActionScope = { ...base, event: on, on, keys: entry.keys as string[] | undefined, underDelay: false, typing, used: { count: 0 } };
  const trigger: Trigger = { id: entry.id, on, do: [] };
  if (entry.if !== undefined) {
    const condition = parseIf(entry.if, scope);
    if (!condition.ok) return condition;
    // Two triggers gated on each other's flags count in unary.
    if (typing) return refuse(TYPING_REASON);
    trigger.if = condition.value;
  }
  const actions = parseActions(entry.do, scope);
  if (!actions.ok) return actions;
  trigger.do = actions.value;
  if (entry.scope === 'document') trigger.scope = 'document';
  if (entry.keys !== undefined) trigger.keys = [...(entry.keys as string[])];
  if (entry.prevent === true) trigger.prevent = true;
  if (on === 'every') trigger.ms = entry.ms as number;
  if (entry.preset === true) trigger.preset = true;
  return accept(trigger);
}

// --- state ----------------------------------------------------------------

function parseState(entry: unknown): Parsed<StateValue> {
  if (!isPlainObject(entry)) return refuse('a state value is an object');
  const { id, name, type, initial } = entry;
  if (typeof id !== 'string' || !STATE_ID.test(id)) return refuse('a state needs a short lower case id');
  if (!isName(name)) return refuse('a state needs a name');
  if (entry.preset !== undefined && entry.preset !== true) return refuse('preset marks an entry with true');
  const mark = entry.preset === true ? { preset: true as const } : {};
  const common = ['id', 'name', 'type', 'initial', 'preset'];

  if (type === 'boolean') {
    if (!hasShape(entry, ['id', 'name', 'type', 'initial'], common)) return refuse('a boolean holds id, name, type and initial');
    if (typeof initial !== 'boolean') return refuse('a boolean starts true or false');
    return accept({ id, name, type, initial, ...mark });
  }
  if (type === 'number') {
    if (!hasShape(entry, ['id', 'name', 'type', 'initial'], [...common, 'min', 'max', 'step'])) return refuse('a number holds id, name, type, initial, min, max and step');
    const { min, max, step } = entry;
    if (!isFiniteNumber(initial)) return refuse('a number starts at a number');
    for (const bound of [min, max, step]) {
      if (bound !== undefined && !isFiniteNumber(bound)) return refuse('min, max and step are numbers');
    }
    const low = min as number | undefined;
    const high = max as number | undefined;
    if (low !== undefined && high !== undefined && low > high) return refuse('min is above max');
    if ((low !== undefined && initial < low) || (high !== undefined && initial > high)) return refuse('initial is outside min and max');
    if (step !== undefined && (step as number) <= 0) return refuse('step is above 0');
    return accept({
      id, name, type, initial,
      ...(low !== undefined ? { min: low } : {}),
      ...(high !== undefined ? { max: high } : {}),
      ...(step !== undefined ? { step: step as number } : {}),
      ...mark,
    });
  }
  if (type === 'choice') {
    if (!hasShape(entry, ['id', 'name', 'type', 'initial', 'options'], [...common, 'options'])) return refuse('a choice holds id, name, type, initial and options');
    const { options } = entry;
    if (!Array.isArray(options) || options.length === 0 || options.length > MAX_OPTIONS) return refuse(`a choice has 1 to ${MAX_OPTIONS} options`);
    if (!options.every(isSafeChoice)) return refuse('an option is short plain text that can reach a selector');
    if (new Set(options).size !== options.length) return refuse('two options are the same');
    if (typeof initial !== 'string' || !options.includes(initial)) return refuse('initial is not one of the options');
    return accept({ id, name, type, initial, options: [...(options as string[])], ...mark });
  }
  if (type === 'text') {
    if (!hasShape(entry, ['id', 'name', 'type', 'initial'], [...common, 'maxLength'])) return refuse('a text value holds id, name, type, initial and maxLength');
    const { maxLength } = entry;
    if (typeof initial !== 'string') return refuse('a text value starts as text');
    if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || (maxLength as number) <= 0)) return refuse('maxLength is a whole number above 0');
    const limit = Math.min((maxLength as number | undefined) ?? MAX_TEXT_INITIAL, MAX_TEXT_INITIAL);
    if (initial.length > limit) return refuse('initial is longer than maxLength');
    return accept({ id, name, type, initial, ...(maxLength !== undefined ? { maxLength: maxLength as number } : {}), ...mark });
  }
  return refuse(`${String(type)} is not a state type`);
}

// --- bindings -------------------------------------------------------------

/**
 * The value of an expression while nothing has happened: state at its initial value
 * and the row when one is given. Pure and total. Undefined when it cannot be known,
 * as for an event, so a caller deciding something safe can fail closed.
 */
export function staticValue(expr: Expression, read: (id: string) => unknown, row?: number): unknown {
  if (typeof expr !== 'object' || expr === null) return expr;
  const all = (list: Expression[]): unknown[] | undefined => {
    const values = list.map((entry) => staticValue(entry, read, row));
    return values.includes(undefined) ? undefined : values;
  };
  if ('get' in expr) return read(expr.get);
  if ('row' in expr) return row;
  if ('not' in expr) {
    const value = staticValue(expr.not, read, row);
    return value === undefined ? undefined : !value;
  }
  if ('eq' in expr) {
    const values = all(expr.eq);
    return values && values[0] === values[1];
  }
  if ('gt' in expr) {
    const values = all(expr.gt) as number[] | undefined;
    return values && values[0] > values[1];
  }
  if ('lt' in expr) {
    const values = all(expr.lt) as number[] | undefined;
    return values && values[0] < values[1];
  }
  if ('and' in expr) return all(expr.and)?.every(Boolean);
  if ('or' in expr) return all(expr.or)?.some(Boolean);
  if ('add' in expr) {
    const values = all(expr.add) as number[] | undefined;
    return values && values[0] + values[1];
  }
  if ('clamp' in expr) {
    const values = all(expr.clamp) as number[] | undefined;
    return values && Math.min(values[2], Math.max(values[1], values[0]));
  }
  if ('map' in expr) {
    const key = read(expr.map);
    if (key === undefined) return undefined;
    const text = String(key);
    if (Object.hasOwn(expr.cases, text)) return staticValue(expr.cases[text], read, row);
    return expr.default === undefined ? undefined : staticValue(expr.default, read, row);
  }
  return undefined;
}

/** Why this attribute may not be bound on this node, or null. */
function refusedAttribute(attr: unknown, self: NodeFacts): string | null {
  if (typeof attr !== 'string') return 'a binding names an attribute';
  const marked = ARIA_ATTRIBUTE.test(attr) || DATA_ATTRIBUTE.test(attr);
  if (self.island) return marked ? null : 'on an island a binding writes only aria-* and data-u-*';
  return marked || VALUE_ATTRIBUTES.has(attr) ? null : `${attr} cannot be bound`;
}

/** Why a binding's first value would remove content from a page with no script, or null. */
function refusedInitial(attr: string, value: Expression, scope: ExpressionScope): string | null {
  if (attr !== 'inert' && attr !== 'aria-hidden') return null;
  const initial = staticValue(value, (id) => scope.states.get(id)?.initial);
  if (initial === false || (attr === 'aria-hidden' && initial === 'false')) return null;
  return `${attr} must start false, or the server would remove content with no way back`;
}

function parseBinding(entry: unknown, scope: ExpressionScope, insideGroup: boolean): Parsed<Binding> {
  if (!isPlainObject(entry)) return refuse('a binding is an object');
  if (entry.preset !== undefined && entry.preset !== true) return refuse('preset marks an entry with true');
  const mark = entry.preset === true ? { preset: true as const } : {};

  if ('text' in entry) {
    if (!hasShape(entry, ['text'], ['preset'])) return refuse('a text binding holds text alone');
    if (scope.self.island) return refuse('an island owns its text');
    if (!scope.self.oneTextChild) return refuse('a text binding needs exactly one text child and no element child');
    const read = readExpression(entry.text, scope);
    if (!read.ok) return read;
    // `{ active }` reads an item's text, which would launder typed text out of the sink.
    if (read.value.tainted && insideGroup) return refuse('typed text in a focus group could be read back as its active item');
    return accept({ text: read.value.value, ...mark });
  }
  if ('cssVar' in entry) {
    if (!hasShape(entry, ['cssVar', 'from'], ['unit', 'preset'])) return refuse('a custom property binding holds cssVar, from and unit');
    if (scope.self.island) return refuse('on an island a binding writes only aria-* and data-u-*');
    if (typeof entry.cssVar !== 'string' || !CSS_VARIABLE.test(entry.cssVar)) return refuse('a bound custom property starts --u-');
    if (entry.unit !== undefined && entry.unit !== 'px' && entry.unit !== '%' && entry.unit !== 'rem') return refuse('unit is px, % or rem');
    const read = readClean(entry.from, scope);
    if (!read.ok) return read;
    // A string in a custom property could carry an address to whatever reads it.
    if (read.value.kind !== 'number') return refuse('a custom property binding holds numbers only');
    return accept({ cssVar: entry.cssVar, from: read.value.value, ...(entry.unit !== undefined ? { unit: entry.unit as 'px' } : {}), ...mark });
  }
  if ('attr' in entry) {
    if (!hasShape(entry, ['attr', 'from'], ['preset'])) return refuse('an attribute binding holds attr and from');
    const reason = refusedAttribute(entry.attr, scope.self);
    if (reason) return refuse(reason);
    const read = readClean(entry.from, scope);
    if (!read.ok) return read;
    const initial = refusedInitial(entry.attr as string, read.value.value, scope);
    if (initial) return refuse(initial);
    return accept({ attr: entry.attr as string, from: read.value.value, ...mark });
  }
  return refuse('a binding is attr, cssVar or text');
}

/** What a binding writes: two bindings on one target would fight. */
function bindingTarget(binding: Binding): string {
  if ('attr' in binding) return `attr:${binding.attr}`;
  return 'cssVar' in binding ? `css:${binding.cssVar}` : 'text';
}

// --- focus groups ---------------------------------------------------------

function parseGroup(group: unknown, scope: ExpressionScope): Parsed<FocusGroup> {
  if (!isPlainObject(group) || !hasShape(group, ['role', 'axis'], ['wrap', 'virtual'])) return refuse('a group holds role, axis, wrap and virtual');
  if (!groupShapeOk(group)) return refuse('a group needs a role and an axis of line, grid or tree');
  if (scope.self.island) return refuse('an island owns its markup');
  if (group.wrap !== undefined && typeof group.wrap !== 'boolean') return refuse('wrap is true or false');
  const parsed: FocusGroup = { role: group.role as string, axis: group.axis as FocusGroup['axis'] };
  if (group.wrap !== undefined) parsed.wrap = group.wrap;
  if (group.virtual !== undefined) {
    if (!isPlainObject(group.virtual) || !hasShape(group.virtual, ['owner'])) return refuse('virtual names its owner');
    const owner = referenceTo(group.virtual.owner, scope);
    if (!owner.ok) return owner;
    parsed.virtual = { owner: owner.value.key };
  }
  return accept(parsed);
}

// --- one node -------------------------------------------------------------

/** Which part of a node's behaviour was set aside. */
export type BehaviourEntry = 'behaviour' | 'state' | 'on' | 'bind' | 'group' | 'showWhen' | 'noScript' | 'preset';

/** An entry that will not run, and why. */
export interface RefusedEntry {
  entry: BehaviourEntry;
  /** The entry's place in its list. */
  index?: number;
  value: unknown;
  reason: string;
}

export interface ReadBehaviour {
  /** What may run, rebuilt from known fields. Null when nothing is left. */
  behaviour: StoredBehaviour | null;
  refused: RefusedEntry[];
}

export interface BehaviourContext {
  /** The state declared on this node's ancestors, nearest last. */
  states?: ReadonlyMap<string, StateValue>;
  /** Every node a reference may name. Anything else is a reference to nothing. */
  nodes?: ReadonlyMap<string, NodeFacts>;
  /** This node's facts when a tree walk already knows them. */
  self?: NodeFacts;
  /** A group sits on this node or above it. */
  insideGroup?: boolean;
}

const NODE_FIELDS: readonly string[] = ['state', 'on', 'bind', 'group', 'showWhen', 'noScript', 'preset'];
const NO_STATES: ReadonlyMap<string, StateValue> = new Map();
const NO_NODES: ReadonlyMap<string, NodeFacts> = new Map();

/** The serialized size of a stored value, or null when it has no JSON form at all. */
function byteSize(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : new TextEncoder().encode(text).length;
  } catch {
    return null;
  }
}

function readStates(
  stored: Record<string, unknown>,
  inherited: ReadonlyMap<string, StateValue>,
  refused: RefusedEntry[],
): StateValue[] {
  const list = stored.state;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    refused.push({ entry: 'state', value: list, reason: 'state is a list' });
    return [];
  }
  const states: StateValue[] = [];
  (list as unknown[]).forEach((entry, index) => {
    const parsed = holdsBinding(entry) ? refuse('a {{binding}} cannot stand inside behaviour') : parseState(entry);
    const fail = (reason: string) => refused.push({ entry: 'state', index, value: entry, reason });
    if (!parsed.ok) fail(parsed.reason);
    else if (inherited.has(parsed.value.id)) fail(`${parsed.value.id} already exists above this node`);
    else if (states.some((other) => other.id === parsed.value.id)) fail(`${parsed.value.id} is declared twice here`);
    else states.push(parsed.value);
  });
  return states;
}

function readTriggers(stored: Record<string, unknown>, scope: ExpressionScope, refused: RefusedEntry[]): Trigger[] {
  const list = stored.on;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    refused.push({ entry: 'on', value: list, reason: 'on is a list' });
    return [];
  }
  const triggers: Trigger[] = [];
  (list as unknown[]).forEach((entry, index) => {
    const parsed = holdsBinding(entry) ? refuse('a {{binding}} cannot stand inside behaviour') : parseTrigger(entry, scope);
    const fail = (reason: string) => refused.push({ entry: 'on', index, value: entry, reason });
    if (!parsed.ok) fail(parsed.reason);
    else if (triggers.some((other) => other.id === parsed.value.id)) fail('another trigger on this node has the same id');
    else if (triggers.length >= MAX_TRIGGERS_PER_NODE) fail(`a node holds at most ${MAX_TRIGGERS_PER_NODE} triggers`);
    else triggers.push(parsed.value);
  });
  return triggers;
}

function readBindings(stored: Record<string, unknown>, scope: ExpressionScope, insideGroup: boolean, refused: RefusedEntry[]): Binding[] {
  const list = stored.bind;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    refused.push({ entry: 'bind', value: list, reason: 'bind is a list' });
    return [];
  }
  const bindings: Binding[] = [];
  const written = new Set<string>();
  (list as unknown[]).forEach((entry, index) => {
    const parsed = holdsBinding(entry) ? refuse('a {{binding}} cannot stand inside behaviour') : parseBinding(entry, scope, insideGroup);
    const fail = (reason: string) => refused.push({ entry: 'bind', index, value: entry, reason });
    if (!parsed.ok) fail(parsed.reason);
    else if (written.has(bindingTarget(parsed.value))) fail('another binding on this node writes the same thing');
    else {
      written.add(bindingTarget(parsed.value));
      bindings.push(parsed.value);
    }
  });
  return bindings;
}

/**
 * One node's behaviour, entry by entry. Takes untrusted input of any shape and never
 * throws. State comes first, so the node's triggers and bindings can read it; a
 * reference to state or a node that does not exist fails that entry alone.
 *
 * Without `context` nothing outside the node is in reach, so a reference to an
 * ancestor's state or to another node is refused: `readBehaviourTree` supplies both.
 */
export function parseBehaviour(node: BehaviourNode, context: BehaviourContext = {}): ReadBehaviour {
  const props = isPlainObject(node.props) ? node.props : {};
  const stored = props.behaviour;
  if (stored === undefined) return { behaviour: null, refused: [] };
  const whole = (reason: string): ReadBehaviour => ({ behaviour: null, refused: [{ entry: 'behaviour', value: stored, reason }] });

  if (!isPlainObject(stored)) return whole('behaviour is an object');
  const self = context.self ?? nodeFacts(node);
  if (self.tag === null) return whole('this node has no element of its own, so it holds no behaviour');
  const size = byteSize(stored);
  if (size === null) return whole('behaviour has no JSON form');
  if (size > MAX_PROGRAM_BYTES) return whole(`a program holds at most ${MAX_PROGRAM_BYTES} bytes`);

  const refused: RefusedEntry[] = [];
  for (const key of Object.keys(stored)) {
    if (!NODE_FIELDS.includes(key)) refused.push({ entry: 'behaviour', value: stored[key], reason: `${key} is not a behaviour field` });
  }

  const inherited = context.states ?? NO_STATES;
  const declared = readStates(stored, inherited, refused);
  const states = new Map(inherited);
  for (const state of declared) states.set(state.id, state);
  const scope: ExpressionScope = { states, nodes: context.nodes ?? NO_NODES, self };

  const behaviour: StoredBehaviour = {};
  if (declared.length > 0) behaviour.state = declared;

  const insideGroup = context.insideGroup === true || stored.group !== undefined;
  const triggers = readTriggers(stored, scope, refused);
  if (triggers.length > 0) behaviour.on = triggers;
  const bindings = readBindings(stored, scope, insideGroup, refused);
  if (bindings.length > 0) behaviour.bind = bindings;

  const fail = (entry: BehaviourEntry, value: unknown, reason: string) => refused.push({ entry, value, reason });
  if (stored.group !== undefined) {
    const group = holdsBinding(stored.group) ? refuse('a {{binding}} cannot stand inside behaviour') : parseGroup(stored.group, scope);
    if (group.ok) behaviour.group = group.value;
    else fail('group', stored.group, group.reason);
  }
  if (stored.showWhen !== undefined) {
    const condition = holdsBinding(stored.showWhen)
      ? refuse('a {{binding}} cannot stand inside behaviour')
      : parseCondition(stored.showWhen, { states, allowRow: true });
    if (condition.ok) behaviour.showWhen = condition.value;
    else fail('showWhen', stored.showWhen, condition.reason);
  }
  if (stored.noScript !== undefined) {
    if (stored.noScript === 'show' || stored.noScript === 'hide') behaviour.noScript = stored.noScript;
    else fail('noScript', stored.noScript, 'noScript is show or hide');
  }
  if (stored.preset !== undefined) {
    const { preset } = stored;
    const valid = isPlainObject(preset) && hasShape(preset, ['kind', 'version'])
      && typeof preset.kind === 'string' && TOKEN.test(preset.kind) && Number.isSafeInteger(preset.version) && (preset.version as number) > 0;
    if (valid) behaviour.preset = { kind: preset.kind as string, version: preset.version as number };
    else fail('preset', preset, 'a preset holds its kind and its version');
  }

  return { behaviour: Object.keys(behaviour).length > 0 ? behaviour : null, refused };
}

// --- a whole tree ---------------------------------------------------------

/** A refusal with the node it came from. */
export interface RefusedOnNode extends RefusedEntry {
  nodeId: string | null;
}

export interface ReadBehaviourTree {
  /** What may run, per node object. A node with nothing that may run is absent. */
  behaviours: Map<BehaviourNode, StoredBehaviour>;
  refused: RefusedOnNode[];
}

function childNodes(node: BehaviourNode): BehaviourNode[] {
  return Array.isArray(node.children) ? (node.children as unknown[]).filter(isPlainObject) : [];
}

/** Whether what sits under this node is the island's own: a form's children are ordinary nodes. */
function closesOverChildren(facts: NodeFacts, node: BehaviourNode): boolean {
  if (!facts.island) return false;
  return formKindOf(isPlainObject(node.props) ? node.props : {}) === null;
}

/** Every keyed node of a tree, and how they read. Runs before any trigger, so a forward reference holds. */
function collectNodes(
  node: BehaviourNode,
  insideIsland: boolean,
  facts: Map<BehaviourNode, NodeFacts>,
  byKey: Map<string, NodeFacts>,
): void {
  const own = nodeFacts(node, insideIsland);
  facts.set(node, own);
  if (own.key !== null) {
    const seen = byKey.get(own.key);
    byKey.set(own.key, seen ? mergeFacts(seen, own) : own);
  }
  const closed = insideIsland || closesOverChildren(own, node);
  for (const child of childNodes(node)) collectNodes(child, closed, facts, byKey);
}

/**
 * Every node's behaviour in a tree, with the state on each node's path and every
 * other node in reach, and the page's caps applied in document order: past
 * 2,000 triggers later ones are refused, past 64 kilobytes later nodes are. The
 * program holds one entry per key, so rows or placements repeating an entry are
 * charged once, however many there are. A node with no stable key cannot be found
 * by the runtime or by a reference, so it holds no behaviour.
 */
export function readBehaviourTree(root: BehaviourNode): ReadBehaviourTree {
  const facts = new Map<BehaviourNode, NodeFacts>();
  const nodes = new Map<string, NodeFacts>();
  collectNodes(root, false, facts, nodes);

  const result: ReadBehaviourTree = { behaviours: new Map(), refused: [] };
  let triggers = 0;
  let bytes = 0;
  /** What an entry came to the first time: a repeat ends the same way and costs nothing. */
  const settled = new Map<string, StoredBehaviour | null>();

  const charge = (parsed: StoredBehaviour, nodeId: string | null, refused: RefusedOnNode[]): StoredBehaviour | null => {
    const size = byteSize(parsed) ?? 0;
    if (bytes + size > MAX_PROGRAM_BYTES) {
      refused.push({ nodeId, entry: 'behaviour', value: parsed, reason: `a page holds at most ${MAX_PROGRAM_BYTES} bytes of behaviour` });
      return null;
    }
    bytes += size;
    if (!parsed.on) return parsed;
    const room = Math.max(0, MAX_TRIGGERS_PER_PAGE - triggers);
    parsed.on.slice(room).forEach((value) => {
      refused.push({ nodeId, entry: 'on', value, reason: `a page holds at most ${MAX_TRIGGERS_PER_PAGE} triggers` });
    });
    parsed.on = parsed.on.slice(0, room);
    triggers += parsed.on.length;
    if (parsed.on.length === 0) delete parsed.on;
    return Object.keys(parsed).length > 0 ? parsed : null;
  };

  const walk = (node: BehaviourNode, states: ReadonlyMap<string, StateValue>, insideGroup: boolean): void => {
    const self = facts.get(node) as NodeFacts;
    const nodeId = typeof node.id === 'string' ? node.id : null;
    const stored = isPlainObject(node.props) ? node.props.behaviour : undefined;
    const keyless = self.key === null && self.tag !== null && stored !== undefined;
    const read: ReadBehaviour = keyless
      ? { behaviour: null, refused: [{ entry: 'behaviour', value: stored, reason: 'a node with no stable id holds no behaviour' }] }
      : parseBehaviour(node, { states, nodes, self, insideGroup });
    const refused: RefusedOnNode[] = read.refused.map((entry) => ({ ...entry, nodeId }));
    let parsed = read.behaviour;

    if (parsed) {
      const signature = `${self.key}\u0000${JSON.stringify(parsed)}`;
      if (!settled.has(signature)) settled.set(signature, charge(parsed, nodeId, refused));
      parsed = settled.get(signature) ?? null;
    }

    result.refused.push(...refused);
    if (parsed) result.behaviours.set(node, parsed);

    let below = states;
    if (parsed?.state) {
      const next = new Map(states);
      for (const state of parsed.state) next.set(state.id, state);
      below = next;
    }
    const grouped = insideGroup || parsed?.group !== undefined;
    for (const child of childNodes(node)) walk(child, below, grouped);
  };

  walk(root, new Map(), false);
  return result;
}

// --- writing --------------------------------------------------------------

/**
 * A node's behaviour with emptied keys removed, or undefined when nothing is left,
 * so a saved page stays unchanged once its last trigger is gone. Keeps what the
 * parser would refuse: the panel shows such an entry, editable and deletable.
 */
export function compactBehaviour(stored: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(stored).filter(([, value]) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// --- following a copy -----------------------------------------------------

/** The keys that hold a node reference, wherever they stand in a behaviour. */
const REFERENCE_KEYS: ReadonlySet<string> = new Set([
  'focus', 'rove', 'dialog', 'popover', 'details', 'media', 'fullscreen', 'pictureInPicture', 'scroll', 'form',
  'setProp', 'filter', 'effect', 'of', 'active', 'owner',
]);
/** Past any depth the parser accepts: what is deeper is refused at render anyway. */
const MAX_REMAP_DEPTH = 64;

function remapValue(value: unknown, ids: ReadonlyMap<string, string>, depth: number): unknown {
  if (depth > MAX_REMAP_DEPTH || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => remapValue(entry, ids, depth + 1));
    return mapped.some((entry, index) => entry !== value[index]) ? mapped : value;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, entry] of Object.entries(value)) {
    // A map's case names are its own text, never references.
    const inCases = key === 'cases' && isPlainObject(entry);
    const next = inCases
      ? remapCases(entry as Record<string, unknown>, ids, depth + 1)
      : REFERENCE_KEYS.has(key) && typeof entry === 'string'
        ? (ids.get(entry) ?? entry)
        : remapValue(entry, ids, depth + 1);
    if (next !== entry) {
      copy ??= { ...value };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

function remapCases(cases: Record<string, unknown>, ids: ReadonlyMap<string, string>, depth: number): Record<string, unknown> {
  const entries = Object.entries(cases).map(([key, entry]) => [key, remapValue(entry, ids, depth + 1)] as const);
  return entries.some(([key, entry]) => entry !== cases[key]) ? Object.fromEntries(entries) : cases;
}

/**
 * A copied subtree with its behaviour following the copy: a reference to a node
 * inside it takes the new id, a reference to one outside stays. `ids` maps old id
 * to new. State ids are not node ids and stay, since a copy is a new scope of its
 * own. Works on stored data, valid or not, and on frozen props: it copies what it
 * changes and hands back the same object when nothing did.
 */
export function remapBehaviourRefs<N extends BehaviourNode>(node: N, ids: ReadonlyMap<string, string>): N {
  const props = isPlainObject(node.props) ? node.props : undefined;
  const behaviour = props?.behaviour === undefined ? undefined : remapValue(props.behaviour, ids, 0);
  const children = Array.isArray(node.children)
    ? (node.children as unknown[]).map((child) => (isPlainObject(child) ? remapBehaviourRefs(child, ids) : child))
    : undefined;
  const sameChildren = !children || children.every((child, index) => child === (node.children as unknown[])[index]);
  const sameBehaviour = behaviour === props?.behaviour;
  if (sameBehaviour && sameChildren) return node;
  return { ...node, ...(sameBehaviour ? {} : { props: { ...props, behaviour } }), ...(children ? { children } : {}) } as N;
}
