// src/lib/components/inputs.ts
//
// What a placement can pass to a component: the 17 types of Framer's editor, and
// the one check each value goes through. A value is only known in hydration, so
// the check runs after it resolves, literal or bound. The panel, the AI validator
// and the import run this same function. A value that does not parse is treated
// as absent.
//
// This check is not the only gate, and it does not stand in for the others: see
// "Where the check runs, and what it does not prove" in
// docs/plans/2026-11-02-reusable-components.md.
//
// PURE: no React, no MST. Client and server safe.

import { isSafeSrc, safeHrefFromData } from '@/lib/links/safeHref';
import { cssValueText, unsafeDeclaration } from '@/lib/responsive/responsiveCss';
import type { Parsed } from '@/lib/rules/rules';

export const INPUT_TYPES = [
  'text',
  'number',
  'toggle',
  'color',
  'image',
  'link',
  'choice',
  'richtext',
  'file',
  'date',
  'border',
  'shadow',
  'cursor',
  'transition',
  'list',
  'gallery',
  'event',
] as const;
export type InputType = (typeof INPUT_TYPES)[number];

/** What one item of a `list` may hold: one level of the scalar types, plus `image`. */
const LIST_FIELD_TYPES: ReadonlySet<InputType> = new Set<InputType>(['text', 'number', 'toggle', 'color', 'link', 'choice', 'image']);

/** At most this many items in a `list` or `gallery`. */
export const MAX_LIST_ITEMS = 100;

export interface InputDefinition {
  /** Short, stable, unique in the definition: a rename keeps it. */
  id: string;
  /** The panel's label. */
  name: string;
  type: InputType;
  default?: unknown;
  group?: string;
  description?: string;
  /** `choice`: the values it may take. */
  options?: { label: string; value: string }[];
  /** `text`. */
  multiline?: boolean;
  maxLength?: number;
  /** `number`. */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** `list`: the shape of one item. */
  fields?: InputDefinition[];
}

export interface ImageValue {
  src: string;
  alt: string;
  focalPoint?: { x: number; y: number };
}

export const RICH_TEXT_MARKS = ['strong', 'em', 'u'] as const;
export type RichTextMark = (typeof RICH_TEXT_MARKS)[number];

export interface TextRun {
  text: string;
  marks?: RichTextMark[];
  href?: string;
}

/** What a person calls each type: Framer's editor names. */
export const INPUT_TYPE_LABELS: Readonly<Record<InputType, string>> = {
  text: 'Plain text',
  number: 'Number',
  toggle: 'Toggle',
  color: 'Color',
  image: 'Image',
  link: 'Link',
  choice: 'Option',
  richtext: 'Formatted text',
  file: 'File',
  date: 'Date',
  border: 'Border',
  shadow: 'Shadow',
  cursor: 'Cursor',
  transition: 'Transition',
  list: 'List',
  gallery: 'Gallery',
  event: 'Event',
};

/** The cursor keywords a `cursor` input takes, in the order the panel offers them. */
export const CURSOR_KEYWORDS: readonly string[] = [
  'auto', 'default', 'none', 'context-menu', 'help', 'pointer', 'progress', 'wait', 'cell', 'crosshair', 'text',
  'vertical-text', 'alias', 'copy', 'move', 'no-drop', 'not-allowed', 'grab', 'grabbing', 'all-scroll', 'col-resize',
  'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize',
  'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'zoom-in', 'zoom-out',
];
const CURSORS: ReadonlySet<string> = new Set(CURSOR_KEYWORDS);

const INPUT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNIT = /^[A-Za-z%]{1,8}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
// A colour, a border, a shadow or a transition has no reason to fetch anything.
const FETCHING_FUNCTION = /(?:url|src|image|image-set|cross-fade|element|paint)\s*\(/i;

const accept = (value: unknown): Parsed<unknown> => ({ ok: true, value });
const refuse = (reason: string): Parsed<unknown> => ({ ok: false, reason });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A style value that fetches nothing and passes the check the stylesheet applies. */
function parseStyleText(property: string, value: unknown, label: string): Parsed<unknown> {
  if (typeof value !== 'string') return refuse(`${label} is a string`);
  if (FETCHING_FUNCTION.test(value)) return refuse(`${label} cannot load anything`);
  const text = cssValueText(property, value);
  if (text === undefined) return refuse(`${label} is empty`);
  return unsafeDeclaration(property, text) ? refuse(`${label} is not a safe CSS value`) : accept(text);
}

function parseColor(value: unknown): Parsed<unknown> {
  if (!isRecord(value)) return parseStyleText('color', value, 'a colour');
  const map: Record<string, unknown> = {};
  for (const [breakpoint, entry] of Object.entries(value)) {
    const parsed = parseStyleText('color', entry, 'a colour');
    if (!parsed.ok) return parsed;
    map[breakpoint] = parsed.value;
  }
  return Object.keys(map).length > 0 ? accept(map) : refuse('a colour is a value or a responsive map');
}

function parseImage(value: unknown): Parsed<unknown> {
  // A CMS file cell holds the address alone.
  const image = typeof value === 'string' ? { src: value } : value;
  if (!isRecord(image)) return refuse('an image is an address or { src, alt }');
  const { src, alt, focalPoint } = image;
  if (typeof src !== 'string' || src.trim().length === 0 || !isSafeSrc(src)) return refuse('an image needs a safe address');
  if (alt !== undefined && typeof alt !== 'string') return refuse('an image description is text');
  const parsed: ImageValue = { src: src.trim(), alt: alt ?? '' };
  if (focalPoint !== undefined) {
    const { x, y } = (isRecord(focalPoint) ? focalPoint : {}) as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return refuse('a focal point is { x, y }');
    }
    parsed.focalPoint = { x, y };
  }
  return accept(parsed);
}

function parseRichText(value: unknown): Parsed<unknown> {
  // A plain string, from a CMS for instance, renders as text.
  if (typeof value === 'string') return accept(value);
  if (!isRecord(value) || !Array.isArray(value.runs)) return refuse('formatted text is { runs }');
  const runs: TextRun[] = [];
  for (const run of value.runs) {
    if (!isRecord(run) || typeof run.text !== 'string') return refuse('a run of formatted text holds text');
    const parsed: TextRun = { text: run.text };
    if (run.marks !== undefined) {
      if (!Array.isArray(run.marks) || run.marks.some(mark => !RICH_TEXT_MARKS.includes(mark as RichTextMark))) {
        return refuse('a mark is strong, em or u');
      }
      parsed.marks = run.marks as RichTextMark[];
    }
    if (run.href !== undefined) {
      const href = safeHrefFromData(run.href);
      if (href === null) return refuse('a link in formatted text needs a safe address');
      parsed.href = href;
    }
    runs.push(parsed);
  }
  return accept({ runs });
}

function parseList(definition: InputDefinition, value: unknown): Parsed<unknown> {
  if (!Array.isArray(value)) return refuse('a list is an array');
  if (value.length > MAX_LIST_ITEMS) return refuse(`a list holds at most ${MAX_LIST_ITEMS} items`);
  const fields = definition.fields ?? [];
  const items: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) return refuse('a list item is an object');
    const parsed: Record<string, unknown> = {};
    for (const field of fields) {
      if (item[field.id] === undefined) continue;
      const entry = parseInputValue(field, item[field.id]);
      if (!entry.ok) return refuse(`${field.name}: ${entry.reason}`);
      parsed[field.id] = entry.value;
    }
    items.push(parsed);
  }
  return accept(items);
}

function parseGallery(value: unknown): Parsed<unknown> {
  if (!Array.isArray(value)) return refuse('a gallery is an array');
  if (value.length > MAX_LIST_ITEMS) return refuse(`a gallery holds at most ${MAX_LIST_ITEMS} items`);
  const items: unknown[] = [];
  for (const entry of value) {
    const parsed = parseImage(entry);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return accept(items);
}

function parseNumber(definition: InputDefinition, value: unknown): Parsed<unknown> {
  if (typeof value !== 'number' || !Number.isFinite(value)) return refuse('a number must be finite');
  if (definition.min !== undefined && value < definition.min) return refuse(`at least ${definition.min}`);
  if (definition.max !== undefined && value > definition.max) return refuse(`at most ${definition.max}`);
  return accept(definition.unit ? `${value}${definition.unit}` : value);
}

function parseText(definition: InputDefinition, value: unknown): Parsed<unknown> {
  // A number column bound to a text input reads as its digits.
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return refuse('text is a string');
  if (definition.maxLength !== undefined && text.length > definition.maxLength) {
    return refuse(`at most ${definition.maxLength} characters`);
  }
  return accept(text);
}

/** One value checked against its input. The value it gives back is the one to use. */
export function parseInputValue(definition: InputDefinition, value: unknown): Parsed<unknown> {
  switch (definition.type) {
    case 'text':
      return parseText(definition, value);
    case 'number':
      return parseNumber(definition, value);
    case 'toggle':
      return typeof value === 'boolean' ? accept(value) : refuse('a toggle is true or false');
    case 'color':
      return parseColor(value);
    case 'image':
      return parseImage(value);
    case 'link':
    case 'file': {
      const href = safeHrefFromData(value);
      return href === null ? refuse('not a safe address') : accept(href);
    }
    case 'choice':
      return definition.options?.some(option => option.value === value) ? accept(value) : refuse('not one of the options');
    case 'richtext':
      return parseRichText(value);
    case 'date':
      return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
        ? accept(value)
        : refuse('a date is an ISO 8601 string');
    case 'border':
      return parseStyleText('border', value, 'a border');
    case 'shadow':
      return parseStyleText('boxShadow', value, 'a shadow');
    case 'transition':
      return parseStyleText('transition', value, 'a transition');
    case 'cursor':
      return typeof value === 'string' && CURSORS.has(value) ? accept(value) : refuse('not a cursor keyword');
    case 'list':
      return parseList(definition, value);
    case 'gallery':
      return parseGallery(value);
    case 'event':
      return refuse('an event holds no value: it is wired on the placement');
    default:
      return refuse('an unknown input type');
  }
}

const finiteOrAbsent = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value));
const textOrAbsent = (value: unknown): boolean => value === undefined || typeof value === 'string';

/** Why a stored input cannot be used, or null when it can. */
export function inputDefinitionRefusal(input: unknown): string | null {
  if (!isRecord(input)) return 'an input is an object';
  const { id, name, type, options, fields, min, max, step, unit, maxLength, multiline } = input;
  if (typeof id !== 'string' || !INPUT_ID.test(id)) return 'an input id is letters, digits, dashes and underscores';
  if (typeof name !== 'string' || name.length === 0) return `input ${id} has no name`;
  if (!INPUT_TYPES.includes(type as InputType)) return `input ${id} has an unknown type`;
  if (!textOrAbsent(input.group) || !textOrAbsent(input.description)) return `input ${id}: group and description are text`;
  if (![min, max, step].every(finiteOrAbsent)) return `input ${id}: min, max and step are numbers`;
  if (unit !== undefined && (typeof unit !== 'string' || !UNIT.test(unit))) return `input ${id} has an unusable unit`;
  if (maxLength !== undefined && (!Number.isInteger(maxLength) || (maxLength as number) < 0)) {
    return `input ${id}: maxLength is a whole number`;
  }
  if (multiline !== undefined && typeof multiline !== 'boolean') return `input ${id}: multiline is true or false`;
  if (type === 'choice') {
    const valid = Array.isArray(options) && options.length > 0
      && options.every(option => isRecord(option) && typeof option.label === 'string' && typeof option.value === 'string');
    if (!valid) return `input ${id} needs options`;
  }
  if (type === 'list') {
    if (!Array.isArray(fields) || fields.length === 0) return `input ${id} needs fields`;
    for (const field of fields) {
      const reason = inputDefinitionRefusal(field);
      if (reason) return reason;
      if (!LIST_FIELD_TYPES.has((field as InputDefinition).type)) return `input ${id}: a list field is a scalar or an image`;
    }
  }
  if (input.default !== undefined) {
    const parsed = parseInputValue(input as unknown as InputDefinition, input.default);
    if (!parsed.ok) return `input ${id} has a default it refuses: ${parsed.reason}`;
  }
  return null;
}

/** The fields of an input that only one type reads, dropped when its type changes. */
const PER_TYPE_FIELDS = ['options', 'multiline', 'maxLength', 'min', 'max', 'step', 'unit', 'fields'] as const;

/**
 * The options of a `choice` input as the panel writes them: `Light, Dark`, one per
 * comma, the label its own value, or `Dark = dark` where the two differ.
 */
export function optionsToText(options: readonly { label: string; value: string }[] | undefined): string {
  return (options ?? []).map(({ label, value }) => (label === value ? label : `${label} = ${value}`)).join(', ');
}

/** The options from text `optionsToText` writes, or why it cannot be read. */
export function optionsFromText(text: string): Parsed<{ label: string; value: string }[]> {
  const entries = text.split(',').map(entry => entry.trim()).filter(entry => entry !== '');
  if (entries.length === 0) return { ok: false, reason: 'an option input needs at least one option' };
  const options = entries.map(entry => {
    const at = entry.indexOf('=');
    if (at === -1) return { label: entry, value: entry };
    return { label: entry.slice(0, at).trim(), value: entry.slice(at + 1).trim() };
  });
  if (options.some(option => option.label === '' || option.value === '')) {
    return { ok: false, reason: 'each option needs a label and a value' };
  }
  if (new Set(options.map(option => option.value)).size !== options.length) {
    return { ok: false, reason: 'two options have the same value' };
  }
  return { ok: true, value: options };
}

/**
 * The same input with another type, ready for `changeInputType`: its id, name,
 * group and description stay, the fields only the old type read go, and a type
 * that needs more gets a start (an Option its default as the first choice, a List
 * one text field). The default stays only when the new type takes it.
 */
export function retypedInput(input: InputDefinition, type: InputType): { next: InputDefinition; defaultDropped: boolean } {
  if (type === input.type) return { next: input, defaultDropped: false };
  const next: InputDefinition = { ...input, type };
  for (const field of PER_TYPE_FIELDS) delete next[field];
  delete next.default;
  // An Option starts with the old default as its one choice, so the default stays.
  if (type === 'choice') {
    const first = typeof input.default === 'string' && input.default.trim() !== '' ? input.default : 'Option 1';
    next.options = [{ label: first, value: first }];
  }
  if (type === 'list') next.fields = [{ id: 'text', name: 'Text', type: 'text' }];
  if (input.default === undefined) return { next, defaultDropped: false };
  const kept = parseInputValue(next, input.default).ok;
  if (kept) next.default = input.default;
  return { next, defaultDropped: !kept };
}

/** Slots that are addresses, in lower case. Escaping does not make an address safe. */
const ADDRESS_SLOTS: ReadonlySet<string> = new Set([
  'href', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'xlinkhref', 'data', 'poster', 'cite', 'ping', 'background',
]);

/** The types whose check is an address check. */
const ADDRESS_TYPES: ReadonlySet<InputType> = new Set<InputType>(['image', 'link', 'file']);

/** Whether a value of this type may be bound to this slot. Only addresses are restricted. */
export function mayBindToSlot(type: InputType, slot: string): boolean {
  return !ADDRESS_SLOTS.has(slot.toLowerCase()) || ADDRESS_TYPES.has(type);
}

/** The expression that reads this input into this slot: an image gives its address to `src` and its text to `alt`. */
export function inputExpressionFor(input: Pick<InputDefinition, 'id' | 'type'>, slot: string): string {
  if (input.type === 'image' && slot === 'src') return `{{input.${input.id}.src}}`;
  if (input.type === 'image' && slot === 'alt') return `{{input.${input.id}.alt}}`;
  return `{{input.${input.id}}}`;
}
