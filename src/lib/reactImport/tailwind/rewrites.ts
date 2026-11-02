// What Tailwind writes, as the rule format stores it. Each rewrite is one entry here and
// one test. Nothing in this file decides whether a result is safe: that is `parseRule`,
// which every output goes through afterwards.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Rewrites".

import { HOVER_GATE } from '@/lib/rules/states';
import type { Declaration, FlatEntry } from './flatten';

/** Marks every kept class. `globals.css` defines no `u-` name, so a kept class applies nothing of the editor's. */
export const KEPT_CLASS_PREFIX = 'u-c-';

/** Tailwind's own gate on `hover:`. */
const TAILWIND_HOVER = '@media (hover: hover)';
/** The class-based dark variant, the one selector that names a class no element here carries. */
export const DARK_SELECTOR = ':is(.dark *)';
export const SYSTEM_DARK = '@media (prefers-color-scheme: dark)';

/** Longer than any rule the parser takes, by a margin. A candidate can be any length, and every scan below is bounded by this. */
const MAX_REWRITABLE_SELECTOR = 1024;

/** `--tw-` to `--u-tw-`, outside strings: `@property` is global, and on the canvas the document is the editor's. */
export function renameCustomProperties(text: string): string {
  if (!text.includes('--tw-')) return text;
  return text.replace(/"[^"]*"|'[^']*'|--tw-/g, (match) => (match === '--tw-' ? '--u-tw-' : match));
}

/** `background-color` to `backgroundColor`, and `-webkit-mask` to `WebkitMask`. */
export function styleKey(property: string): string {
  if (property.startsWith('--')) return renameCustomProperties(property);
  const vendor = /^-(webkit|moz|ms|o)-/.exec(property);
  const rest = vendor ? property.slice(vendor[0].length) : property;
  const camel = rest.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (!vendor) return camel;
  const prefix = vendor[1] === 'ms' ? 'ms' : vendor[1][0].toUpperCase() + vendor[1].slice(1);
  return prefix + camel[0].toUpperCase() + camel.slice(1);
}

/** Only names this compile produced are rewritten: another name may be one the page defines. */
export function keyframesName(name: string): string {
  return name === 'enter' || name === 'exit' ? `u-tw-${name}` : `u-${name}`;
}

/** `spin 1s linear` with its keyframes under their stored names. */
export function renameAnimations(value: string, produced: ReadonlySet<string>): string {
  return value.replace(/"[^"]*"|'[^']*'|[A-Za-z_-][A-Za-z0-9_-]*/g, (word) => (produced.has(word) ? keyframesName(word) : word));
}

const ANIMATION_KEY = /^(?:animation|animationName|--animate-.*)$/;

/** One value as it is stored. An `!important` one never gets here: it is refused where it is read. */
export function storedValue(key: string, value: string, produced: ReadonlySet<string>): string {
  const renamed = renameCustomProperties(value);
  return ANIMATION_KEY.test(key) ? renameAnimations(renamed, produced) : renamed;
}

/** The style of a list of declarations. A repeated key moves to the end, as a later declaration wins. */
export function styleOf(declarations: readonly Declaration[], produced: ReadonlySet<string>): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  for (const { property, value } of declarations) {
    const key = styleKey(property);
    delete style[key];
    style[key] = storedValue(key, value, produced);
  }
  return style;
}

/** The index of the `)` closing the `(` at `open`, skipping strings, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = text.indexOf(ch, i + 1);
      if (i === -1) return -1;
    } else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Where `inner` steps from its first compound to what it reaches: the combinator's start and end, or null. */
function firstStep(inner: string): { start: number; end: number } | null {
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '"' || ch === "'") {
      i = inner.indexOf(ch, i + 1);
      if (i === -1) return null;
    } else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (depth === 0 && ch === ' ') {
      const child = inner.startsWith(' > ', i);
      return { start: i, end: i + (child ? 3 : 1) };
    }
  }
  return null;
}

export interface SteppedSelector {
  selector: string;
  /** The form has more weight than Tailwind's, so it beats a child's own Normal. */
  raisesWeight: boolean;
}

/**
 * `:where(& > :not(:last-child))`, from `space-y-*`, to `& > :where(:not(:last-child))`, and `:is(& > *)` and
 * `:is(& *)`, from `*:` and `**:`, to `& > *` and `& *`. A part has to start with `&`, so the wrapped forms are refused.
 */
export function steppedOut(selector: string): SteppedSelector {
  const wrapper = /^:(where|is)\(/.exec(selector);
  if (!wrapper) return { selector, raisesWeight: false };
  const open = wrapper[0].length - 1;
  const end = closing(selector, open);
  if (end === -1) return { selector, raisesWeight: false };
  const inner = selector.slice(open + 1, end);
  const step = firstStep(inner);
  if (!inner.startsWith('&') || !step) return { selector, raisesWeight: false };
  const head = inner.slice(0, step.start);
  const combinator = inner.slice(step.start, step.end);
  const tail = inner.slice(step.end);
  const rest = selector.slice(end + 1);
  if (wrapper[1] === 'where') return { selector: `${head}${combinator}:where(${tail})${rest}`, raisesWeight: true };
  return { selector: `${head}${combinator}${tail}${rest}`, raisesWeight: false };
}

/**
 * A source class as text a kept class may hold, one to one: `_` becomes `__`, `/` becomes `_s`, and any other
 * character outside letters, digits, `-`, `:`, `.` and `%` becomes `_x<hex>_`. So `group/item` and `group-item`
 * stay two classes, and since each character is written alone, a substring of a class stays a substring.
 */
export function encodeClass(text: string): string {
  let out = '';
  for (const ch of text) {
    if (/[A-Za-z0-9:.%-]/.test(ch)) out += ch;
    else if (ch === '_') out += '__';
    else if (ch === '/') out += '_s';
    else out += `_x${(ch.codePointAt(0) as number).toString(16)}_`;
  }
  return out;
}

/** The source class an encoded name stands for, the inverse of `encodeClass`. A name it cannot read comes back as it is. */
export function decodeClass(encoded: string): string {
  let out = '';
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (ch !== '_') {
      out += ch;
      continue;
    }
    const next = encoded[i + 1];
    if (next === '_') {
      out += '_';
      i += 1;
    } else if (next === 's') {
      out += '/';
      i += 1;
    } else if (next === 'x') {
      const end = encoded.indexOf('_', i + 2);
      const code = end > i + 2 ? Number.parseInt(encoded.slice(i + 2, end), 16) : Number.NaN;
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        out += String.fromCodePoint(code);
        i = end;
      } else out += ch;
    } else out += ch;
  }
  return out;
}

/** A class a selector names, as an element carries it, or null when the name is not one a selector may use. */
export function keptClassName(name: string): string | null {
  return /^[A-Za-z0-9_/-]+$/.test(name) ? `${KEPT_CLASS_PREFIX}${encodeClass(name)}` : null;
}

/** One attribute selector on `class`, as a rule reads it. */
export interface ClassReader {
  operator: '*=' | '^=' | '~=' | '|=';
  operand: string;
  caseInsensitive: boolean;
}

/** A kept class in full, under the same encoding, so a reader's encoded operand still finds it. */
export const keptSourceClass = (token: string): string => `${KEPT_CLASS_PREFIX}${encodeClass(token)}`;

/** The operand a reader is stored with: a kept class from its start, so it cannot read the renderer's or the canvas's own classes. */
export const storedOperand = ({ operand }: ClassReader): string => `${KEPT_CLASS_PREFIX}${encodeClass(operand)}`;

/** Whether the stored reader matches a kept class: what the replica does, beside `readsClass`, what the original did. */
export function storedReads(reader: ClassReader, kept: string): boolean {
  const name = reader.caseInsensitive ? kept.toLowerCase() : kept;
  const wanted = reader.caseInsensitive ? storedOperand(reader).toLowerCase() : storedOperand(reader);
  if (reader.operator === '*=') return name.includes(wanted);
  if (reader.operator === '^=') return name.startsWith(wanted);
  if (reader.operator === '~=') return name === wanted;
  return name === wanted || name.startsWith(`${wanted}-`);
}

/** Whether a reader could match this source class, on the name as it stood in the source. */
export function readsClass({ operator, operand, caseInsensitive }: ClassReader, token: string): boolean {
  const name = caseInsensitive ? token.toLowerCase() : token;
  const wanted = caseInsensitive ? operand.toLowerCase() : operand;
  if (operator === '*=') return name.includes(wanted);
  if (operator === '^=') return name.startsWith(wanted);
  if (operator === '~=') return name === wanted;
  return name === wanted || name.startsWith(`${wanted}-`);
}

const CLASS_ATTRIBUTE = /\[ *class *(?:([~|^$*]?=) *("[^"\]]*"|'[^'\]]*'|[^\s\]"']+) *([iIsS])? *)?\]/gi;

export interface ReadSelector {
  selector: string;
  /** Classes the selector names: elements carrying one keep it. */
  names: string[];
  readers: ClassReader[];
  refused?: string;
}

/** Text with classes that take the prefix. Outside strings and brackets, since `[title=".a"]` names none. */
function prefixClasses(text: string, names: string[]): string | null {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end === -1) return null;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '[') {
      const end = closing(text, i);
      if (end === -1) return null;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '.') {
      const match = /^(?:[A-Za-z0-9_-]|\\.)+/.exec(text.slice(i + 1));
      if (!match) return null;
      const name = match[0].replace(/\\(.)/g, '$1');
      const kept = keptClassName(name);
      if (!kept) return null;
      names.push(name);
      out += `.${kept}`;
      i += match[0].length + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Operands that would read the platform's own classes rather than the source's. */
const readsPlatformClass = (operand: string): boolean =>
  KEPT_CLASS_PREFIX.includes(operand) || 'fc-'.includes(operand) || 'fc_'.includes(operand) || operand.startsWith(KEPT_CLASS_PREFIX);

/**
 * What a selector reads from `class`, each kind handled once. A class it names, `group` and any other, takes the
 * prefix in the selector and on the element, which also turns `.group\/item`, refused for its backslash, into
 * `.u-c-group_sitem`. An attribute selector is listed so that the classes it could read are kept, and `^=`, `~=` and
 * `|=` take the prefix in their operand. `=` and `$=` read the whole attribute, which holds the renderer's classes
 * too, and a reader that could match those would mean something else: both are refused.
 */
export function readSelector(selector: string): ReadSelector {
  const names: string[] = [];
  const readers: ClassReader[] = [];
  if (selector.length > MAX_REWRITABLE_SELECTOR) return { selector, names, readers, refused: 'a selector part is too long' };
  let refused: string | undefined;
  const withOperands = selector.replace(CLASS_ATTRIBUTE, (whole, operator: string | undefined, quoted: string | undefined, flag: string | undefined) => {
    const operand = quoted?.replace(/^["']|["']$/g, '') ?? '';
    if (operator !== '*=' && operator !== '^=' && operator !== '~=' && operator !== '|=') {
      refused = 'this attribute selector reads the whole class attribute, which holds the renderer\'s classes';
      return whole;
    }
    if (operand === '' || readsPlatformClass(operand)) {
      refused = 'this attribute selector would read the platform\'s own class names';
      return whole;
    }
    readers.push({ operator, operand, caseInsensitive: flag === 'i' || flag === 'I' });
    // Stored as a kept class from its start, for every operator: a bare `*=` would also read the classes the canvas
    // and the renderer write, and the encoding of a kept class (`[class*=si]` in `u-c-group_sitem`).
    const flagText = flag ? ` ${flag}` : '';
    return `[class${operator}"${storedOperand({ operator, operand, caseInsensitive: false })}"${flagText}]`;
  });
  if (refused) return { selector, names, readers, refused };
  const pieces = withOperands.split(DARK_SELECTOR).map((piece) => prefixClasses(piece, names));
  if (pieces.some((piece) => piece === null)) return { selector, names, readers, refused: 'it names a class that cannot be kept' };
  return { selector: pieces.join(DARK_SELECTOR), names, readers };
}

export interface RewrittenEntry {
  entry: FlatEntry;
  /** `hover:` under the Hover state's stricter gate: a device with hover and a coarse primary pointer shows none. */
  hoverGated: boolean;
  dark: boolean;
  raisesWeight: boolean;
  names: string[];
  readers: ClassReader[];
  refused?: string;
}

/** The rewrites that depend on the entry alone, each from the table in the contract. */
export function rewriteEntry(entry: FlatEntry, options: { systemDark: boolean }): RewrittenEntry {
  const stepped = steppedOut(entry.selector);
  const read = readSelector(stepped.selector);
  const dark = read.selector.includes(DARK_SELECTOR);
  const useMedia = dark && options.systemDark;
  const selector = useMedia ? read.selector.split(DARK_SELECTOR).join('') : read.selector;
  const at = useMedia ? [SYSTEM_DARK, ...entry.at] : entry.at;
  const hoverGated = selector === '&:hover' && at.includes(TAILWIND_HOVER);
  return {
    entry: { ...entry, selector, at: hoverGated ? at.map((wrapper) => (wrapper === TAILWIND_HOVER ? HOVER_GATE : wrapper)) : at },
    hoverGated,
    dark: dark && !options.systemDark,
    raisesWeight: stepped.raisesWeight,
    names: read.names,
    readers: read.readers,
    ...(read.refused ? { refused: read.refused } : {}),
  };
}
