// src/lib/ai/pageGen/promptSections/behaviour.ts
//
// What the page generator may do with `props.behaviour`, and the model-facing text that
// says so. Plan: docs/plans/2026-11-02-behaviour-model.md, "AI output".
//
// The generator is taught presets, not primitives. A generated node may be a preset
// request, `{ "preset": "tabs", "items": [...], "options": {...} }`, which the validator
// expands through the same function the palette calls (src/lib/behaviour/presets), with
// only the text and numbers the model gave cleaned here. Besides the presets the prompt
// teaches one simple form, a press that toggles a value and a node shown when it is set.
// Everything else `parseBehaviour` accepts is accepted too, and the score labels it
// `accepted, not taught`, as it does for rules.
//
// Generated behaviour is held to more than authored behaviour, because a generation may
// have been written by a prompt injection in a brief:
//
//   - Nothing moves by itself unasked: an `every` trigger is refused, and a carousel is
//     never generated with a rotation.
//   - `navigate` takes a site path or an anchor only. An address that leaves the site is
//     a person's choice in the panel (decision M6).
//   - `customCode` is never written by a generator, only by a person through the guarded
//     route, because content the generator reads can carry instructions.
//   - At most MAX_GENERATED_TRIGGERS triggers the model wrote itself, and at most
//     MAX_GENERATED_PRESETS presets, per generation.
//
// PURE: no React, no MST.

import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { isSafeHref } from '@/lib/links/safeHref';
import { leavesSite, type Action, type Trigger } from '@/lib/behaviour/format';
import type { PresetKind, PresetNode } from '@/lib/behaviour/presets';
import { carousel } from '@/lib/behaviour/presets/carousel';
import { combobox } from '@/lib/behaviour/presets/combobox';
import { feed } from '@/lib/behaviour/presets/feed';
import { grid } from '@/lib/behaviour/presets/grid';
import { menuButton } from '@/lib/behaviour/presets/menu';
import { menubar } from '@/lib/behaviour/presets/menubar';
import { multithumbSlider } from '@/lib/behaviour/presets/slider';
import { splitter } from '@/lib/behaviour/presets/splitter';
import { tabs } from '@/lib/behaviour/presets/tabs';
import { toolbar } from '@/lib/behaviour/presets/toolbar';
import { tooltip } from '@/lib/behaviour/presets/tooltip';
import { treegrid, treeview, type TreeEntry, type TreegridEntry } from '@/lib/behaviour/presets/tree';

/** The node prop that carries behaviour (props.behaviour, as in the editor). */
export const BEHAVIOUR_PROP = 'behaviour';

/** The node prop of a custom code block. A generator never writes one. */
export const CUSTOM_CODE_PROP = 'customCode';

/** Most triggers the model may write itself in one generation; the rest are dropped with a warning. */
export const MAX_GENERATED_TRIGGERS = 24;

/** Most presets one generation may place; the rest are dropped with a warning. */
export const MAX_GENERATED_PRESETS = 6;

/** The event handler rows the prompt teaches: a press that toggles a value. */
export const TAUGHT_EVENT_ROWS: ReadonlySet<string> = new Set(['onclick']);

/** Why a generator never writes custom code, as every refusal says it. */
export const CUSTOM_CODE_REASON = 'custom code is never written by a generator, only by a person through the guarded route';

const MAX_ITEMS = 12;
const MAX_OPTIONS = 24;
const MAX_MENUS = 6;
const MAX_MENU_ITEMS = 8;
const MAX_COLUMNS = 8;
const MAX_TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 24;
const MAX_LABEL_CHARS = 80;
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 2000;
const NUMBER_LIMIT = 1_000_000;

// --- what the generator may not write, beyond the parser --------------------

function actionsOf(actions: readonly Action[]): Action[] {
  return actions.flatMap((action) => ('delay' in action ? [action, ...actionsOf(action.do)] : [action]));
}

/** Why the generator may not keep this parsed trigger, or null. */
export function generatedTriggerRefusal(trigger: Trigger): string | null {
  if (trigger.on === 'every') return 'nothing generated runs on a timer: every is refused';
  for (const action of actionsOf(trigger.do)) {
    if ('navigate' in action && leavesSite(action.navigate)) return 'a generated navigate goes to a site path or an anchor only';
  }
  return null;
}

// --- preset requests --------------------------------------------------------

/** The palette's names for its presets, which is what the model asks for. */
const PRESET_ENTRIES: ReadonlyMap<string, PresetKind> = new Map(
  Object.values(COMPONENT_REGISTRY).flatMap((entry) => (entry.preset ? [[entry.id, entry.preset] as const] : [])),
);

/** The behaviour preset a registry name asks for, or undefined. */
export function behaviourPresetOf(name: unknown): PresetKind | undefined {
  return typeof name === 'string' ? PRESET_ENTRIES.get(name) : undefined;
}

/** The node keys a preset request reads. */
export const PRESET_REQUEST_KEYS: ReadonlySet<string> = new Set(['preset', 'label', 'items', 'options']);

type Warn = (message: string) => void;
type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);

/** Trimmed text with its whitespace collapsed, at most `max` characters, or undefined. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean === '' ? undefined : clean.slice(0, max);
}

function number(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/** Each entry of a list read by `read`, the unreadable ones dropped with a warning, the list capped. */
function list<T>(value: unknown, what: string, max: number, read: (entry: unknown, at: number) => T | undefined, warn: Warn): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warn(`${what} must be a list, dropped`);
    return [];
  }
  if (value.length > max) warn(`at most ${max} ${what}, ${value.length - max} dropped`);
  const out: T[] = [];
  value.slice(0, max).forEach((entry, at) => {
    const kept = read(entry, at);
    if (kept === undefined) warn(`${what}[${at}] is not usable, dropped`);
    else out.push(kept);
  });
  return out;
}

const plainText = (max: number) => (entry: unknown) => text(entry, max);

const titled = (entry: unknown): { title: string; body: string } | undefined => {
  if (!isRecord(entry)) return undefined;
  const title = text(entry.title, MAX_TITLE_CHARS);
  const body = text(entry.body, MAX_BODY_CHARS);
  return title && body ? { title, body } : undefined;
};

const link = (entry: unknown): { title: string; href: string } | undefined => {
  if (!isRecord(entry)) return undefined;
  const title = text(entry.title, MAX_TITLE_CHARS);
  const href = typeof entry.href === 'string' && isSafeHref(entry.href.trim()) ? entry.href.trim() : undefined;
  return title && href ? { title, href } : undefined;
};

/** A nested list, capped in depth and in entries over the whole tree. */
function nested<T>(value: unknown, what: string, readOwn: (entry: Fields) => Omit<T, 'children'> | undefined, warn: Warn): T[] {
  let left = MAX_TREE_ENTRIES;
  const level = (entries: unknown, depth: number): T[] => list(entries, what, left, (entry) => {
    if (!isRecord(entry) || left <= 0) return undefined;
    const own = readOwn(entry);
    if (!own) return undefined;
    left -= 1;
    if (entry.children === undefined) return own as T;
    if (depth >= MAX_TREE_DEPTH) {
      warn(`${what} nest at most ${MAX_TREE_DEPTH} levels, deeper ones dropped`);
      return own as T;
    }
    const children = level(entry.children, depth + 1);
    return (children.length > 0 ? { ...own, children } : own) as T;
  }, warn);
  return level(value, 1);
}

/** The model's request, read per kind into the preset function's options. */
interface Request {
  items: unknown;
  options: Fields;
  warn: Warn;
}

type Builder = (seed: string, label: string, request: Request) => PresetNode | string;

const atLeast = (count: number, got: unknown[], what: string): string | null =>
  got.length >= count ? null : `needs at least ${count} ${what}`;

const BUILDERS: Record<PresetKind, Builder> = {
  tabs: (seed, label, { items, options, warn }) => {
    const entries = list(items, 'items', 8, titled, warn);
    const vertical = options.orientation === 'vertical';
    return atLeast(2, entries, 'items with a title and a body') ?? tabs({ seed, label, items: entries, orientation: vertical ? 'vertical' : 'horizontal' });
  },
  toolbar: (seed, label, { items, warn }) => {
    const entries = list(items, 'items', MAX_ITEMS, plainText(MAX_TITLE_CHARS), warn);
    return atLeast(2, entries, 'items') ?? toolbar({ seed, label, items: entries });
  },
  tooltip: (seed, label, { options }) => {
    const tip = text(options.text, MAX_BODY_CHARS);
    return tip ? tooltip({ seed, label, text: tip }) : 'needs options.text, what the tooltip says';
  },
  carousel: (seed, label, { items, options, warn }) => {
    if (options.rotateMs !== undefined) warn('a generated carousel never rotates by itself: rotateMs dropped');
    const slides = list(items, 'items', MAX_ITEMS, plainText(MAX_BODY_CHARS), warn);
    return atLeast(2, slides, 'slides') ?? carousel({ seed, label, slides });
  },
  'menu-button': (seed, label, { items, warn }) => {
    const entries = list(items, 'items', MAX_ITEMS, plainText(MAX_TITLE_CHARS), warn);
    return atLeast(1, entries, 'item') ?? menuButton({ seed, label, items: entries });
  },
  menubar: (seed, label, { items, warn }) => {
    const menus = list(items, 'items', MAX_MENUS, (entry) => {
      const top = link(entry);
      if (!top || !isRecord(entry)) return undefined;
      const links = list(entry.items, 'menu items', MAX_MENU_ITEMS, link, warn);
      return links.length > 0 ? { ...top, items: links } : undefined;
    }, warn);
    return atLeast(1, menus, 'menu with a title, an href and items') ?? menubar({ seed, label, menus });
  },
  combobox: (seed, label, { items, warn }) => {
    const entries = list(items, 'items', MAX_OPTIONS, plainText(MAX_TITLE_CHARS), warn);
    return atLeast(1, entries, 'option') ?? combobox({ seed, label, options: entries });
  },
  'slider-multithumb': (seed, label, { options }) => {
    const min = number(options.min, -NUMBER_LIMIT, NUMBER_LIMIT) ?? 0;
    const max = number(options.max, -NUMBER_LIMIT, NUMBER_LIMIT) ?? 100;
    if (max <= min) return 'needs options.min below options.max';
    const low = number(options.low, min, max) ?? min;
    const high = number(options.high, min, max) ?? max;
    return multithumbSlider({ seed, label, min, max, low, high });
  },
  windowsplitter: (seed, label, { options }) => {
    const first = text(options.first, MAX_BODY_CHARS);
    const second = text(options.second, MAX_BODY_CHARS);
    if (!first || !second) return 'needs options.first and options.second, what each pane says';
    return splitter({ seed, label, first, second, at: Math.round(number(options.at, 10, 90) ?? 50) });
  },
  feed: (seed, label, { items, warn }) => {
    const articles = list(items, 'items', MAX_ITEMS, titled, warn);
    return atLeast(1, articles, 'item with a title and a body') ?? feed({ seed, label, articles });
  },
  grid: (seed, label, { items, options, warn }) => {
    const columns = list(options.columns, 'columns', MAX_COLUMNS, plainText(MAX_TITLE_CHARS), warn);
    if (columns.length === 0) return 'needs options.columns';
    const rows = list(items, 'rows', MAX_ITEMS, (row) => {
      const cells = Array.isArray(row) ? row.map((cell) => text(cell, MAX_TITLE_CHARS)) : [];
      return cells.length === columns.length && cells.every((cell) => cell !== undefined) ? (cells as string[]) : undefined;
    }, warn);
    return atLeast(1, rows, 'row with one cell per column') ?? grid({ seed, label, columns, rows });
  },
  treeview: (seed, label, { items, warn }) => {
    const entries = nested<TreeEntry>(items, 'items', (entry) => {
      const title = text(entry.title, MAX_TITLE_CHARS);
      return title ? { title } : undefined;
    }, warn);
    return atLeast(1, entries, 'item with a title') ?? treeview({ seed, label, items: entries });
  },
  treegrid: (seed, label, { items, options, warn }) => {
    const columns = list(options.columns, 'columns', MAX_COLUMNS, plainText(MAX_TITLE_CHARS), warn);
    if (columns.length === 0) return 'needs options.columns';
    const rows = nested<TreegridEntry>(items, 'rows', (entry) => {
      const cells = Array.isArray(entry.cells) ? entry.cells.map((cell) => text(cell, MAX_TITLE_CHARS)) : [];
      return cells.length === columns.length && cells.every((cell) => cell !== undefined) ? { cells: cells as string[] } : undefined;
    }, warn);
    return atLeast(1, rows, 'row with one cell per column') ?? treegrid({ seed, label, columns, rows });
  },
};

/** The option keys each preset reads; anything else is warned about and ignored. */
const OPTION_KEYS: Record<PresetKind, readonly string[]> = {
  tabs: ['label', 'orientation'],
  toolbar: ['label'],
  tooltip: ['label', 'text'],
  carousel: ['label', 'rotateMs'],
  'menu-button': ['label'],
  menubar: ['label'],
  combobox: ['label'],
  'slider-multithumb': ['label', 'min', 'max', 'low', 'high'],
  windowsplitter: ['label', 'first', 'second', 'at'],
  feed: ['label'],
  grid: ['label', 'columns'],
  treeview: ['label'],
  treegrid: ['label', 'columns'],
};

/** Presets that take no list of items. */
const WITHOUT_ITEMS: ReadonlySet<PresetKind> = new Set(['tooltip', 'slider-multithumb', 'windowsplitter']);

/**
 * The nodes a preset request asks for, built by the palette's own function, or why none
 * can be built. Only what the model wrote is cleaned here: the preset's tags, attributes,
 * rules and behaviour are the palette's. Never throws.
 */
export function expandPresetRequest(
  kind: PresetKind,
  raw: Fields,
  seed: string,
  warn: Warn,
): { root: PresetNode } | { refused: string } {
  const options = raw.options === undefined ? {} : raw.options;
  if (!isRecord(options)) return { refused: 'options must be an object' };
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS[kind].includes(key)) warn(`option "${key}" is not one of ${kind}'s, ignored`);
  }
  if (WITHOUT_ITEMS.has(kind) && raw.items !== undefined) warn(`${kind} takes no items, ignored`);
  const label = text(options.label, MAX_LABEL_CHARS);
  if (!label) return { refused: 'needs options.label, its name for a screen reader, in the page\'s language' };
  try {
    const built = BUILDERS[kind](seed, label, { items: raw.items, options, warn });
    return typeof built === 'string' ? { refused: built } : { root: built };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : 'the preset could not be built' };
  }
}

// --- the prompt -------------------------------------------------------------

const PRESET_LINES: Readonly<Record<PresetKind, string>> = {
  tabs: 'items [{"title","body"}] (2 to 8); options {"label", "orientation": "horizontal" or "vertical"}',
  toolbar: `items ["<button text>"] (2 to ${MAX_ITEMS}); options {"label"}`,
  tooltip: 'no items; options {"label": "<the button\'s text>", "text": "<what the tooltip says>"}',
  carousel: `items ["<slide text>"] (2 to ${MAX_ITEMS}); options {"label"}. It moves only when a visitor moves it`,
  'menu-button': `items ["<item text>"] (1 to ${MAX_ITEMS}); options {"label": "<the button\'s text>"}`,
  menubar: `items [{"title","href","items":[{"title","href"}]}] (1 to ${MAX_MENUS} menus, 1 to ${MAX_MENU_ITEMS} links each); options {"label"}`,
  combobox: `items ["<option>"] (1 to ${MAX_OPTIONS}); options {"label"}`,
  'slider-multithumb': 'no items; options {"label", "min", "max", "low", "high"} (numbers)',
  windowsplitter: 'no items; options {"label", "first", "second"} (what each pane says), "at" (10 to 90, percent)',
  feed: `items [{"title","body"}] (1 to ${MAX_ITEMS}); options {"label"}`,
  grid: `items [["<cell>", ...]] (rows, 1 to ${MAX_ITEMS}, one cell per column); options {"label", "columns": ["<heading>"]}`,
  treeview: `items [{"title","children":[...]}] (at most ${MAX_TREE_DEPTH} levels, ${MAX_TREE_ENTRIES} items); options {"label"}`,
  treegrid: `items [{"cells":["<cell>"],"children":[...]}] (at most ${MAX_TREE_DEPTH} levels, ${MAX_TREE_ENTRIES} rows); options {"label", "columns"}`,
};

/** The "## Behaviour" section of the schema docs (part of the cached prefix: keep it tight). */
export function behaviourDocs(): string {
  const names = [...PRESET_ENTRIES.entries()].map(([name, kind]) => `- "${name}": ${PRESET_LINES[kind]}.`);
  return [
    '## Behaviour',
    '',
    'Components a visitor operates are presets. Ask for one as a node of its own, with no type, props or children:',
    '{"preset": "<name>", "label": "<layers name>", "items": [ ... ], "options": { ... }}',
    'The editor builds it with keyboard support and a version that works without JavaScript. "options.label"',
    'is required: its name for a screen reader, in the page\'s language. Names:',
    ...names,
    `At most ${MAX_GENERATED_PRESETS} presets per generation. Use one only when the brief needs that kind of`,
    'component: a question list is a details element per question, which needs no preset.',
    '',
    'One form you may write yourself, a button that shows and hides a part of its section: the section',
    'declares a value, the button toggles it, the part is shown while it is true.',
    '{"type":"div","props":{"behaviour":{"state":[{"id":"open","name":"Open","type":"boolean","initial":false}]}},',
    ' "children":[{"type":"button","props":{"type":"button","children":"Show details","behaviour":{"on":[{"id":"press",',
    '  "on":"click","do":[{"toggle":"open"}]}],"bind":[{"attr":"aria-expanded","from":{"get":"open"}}]}}},',
    '  {"type":"p","props":{"children":"...","behaviour":{"showWhen":{"state":"open","eq":true}}}}]}',
    'A value is read only by the nodes inside the one declaring it. Nothing else: no timers, no other events,',
    `no links or code in behaviour. At most ${MAX_GENERATED_TRIGGERS} triggers per generation; anything that does not fit is dropped.`,
  ].join('\n');
}
