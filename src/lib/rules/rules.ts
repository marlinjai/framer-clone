// src/lib/rules/rules.ts
//
// The stored form of CSS that needs a selector or an at-rule, and the one parser
// that decides whether such text may reach a stylesheet. See
// docs/plans/2026-11-02-selector-styling.md.
//
// `props.rules` is an ordered list beside `props.style`. Save and publish keep a
// page as opaque JSON, so nothing here can be assumed to have been checked when
// it was written: this parser runs at emission in every renderer, and again in
// the panel, the AI validator and the import. Its refusals are the security
// boundary. A rule that does not parse is refused whole, never partly applied,
// and the reason comes back so the panel can show it.
//
// What a refusal protects:
//
//   - The <style> element and the rule. `dangerouslySetInnerHTML` writes the
//     sheet raw, so `<` must not reach a selector or a prelude, and `{ } ; \` and
//     comments must not reach anything.
//   - The node. A selector starts with `&`, and only child and descendant steps
//     can leave it, so the subject of a rule is the node or something inside it.
//     A condition inside `:is()`, `:not()` or `:has()` may still read the whole
//     document, which is how `&:is(.dark *)` works.
//   - The visitor. A rule makes a request conditional, so a rule cannot hold an
//     external address in any form, see `scanValue`. A selector also cannot read
//     what a visitor types: attribute selectors on `value` with an operator are
//     refused, because React mirrors a controlled input's value into the attribute.
//   - The editor. Global names must carry the `u-` prefix, because on the canvas
//     the document is the editor itself.
//
// PURE and client-safe: no React, no MST, no new dependency.

import { SAFE_PROPERTY, UNSAFE_VALUE, cssValueText, isStyleMap } from '@/lib/responsive/responsiveCss';

/** One rule that applies to the node or to something inside it. */
export interface SelectorRule {
  /** Short, unique within the node, never emitted. */
  id: string;
  /** Starts with `&`: `&:hover`, `&::before`, `& > li`. */
  selector: string;
  /** Wrappers, outermost first: `@media (prefers-color-scheme: dark)`. */
  at?: string[];
  /** Exactly the shape of `props.style`: scalars and responsive maps. */
  style: Record<string, unknown>;
}

/** One global definition, kept on a node so it travels with that node. */
export interface DefinitionRule {
  id: string;
  /** The whole prelude: `@keyframes u-spin`, `@font-face`. */
  define: string;
  /** Descriptors, plain values only, no responsive maps. */
  style?: Record<string, unknown>;
  /** `from`, `50%`, `@styleset`. */
  blocks?: { selector: string; style: Record<string, unknown> }[];
}

/** `props.rules`: order matters, a later rule wins a tie. Absent when empty. */
export type StoredRule = SelectorRule | DefinitionRule;

/** A verdict that says why, because the panel and the import report the reason. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A selector rule the parser accepted, with its list split into parts. */
export interface ParsedSelectorRule {
  kind: 'selector';
  id: string;
  /** One entry per part of the list. A browser drops a whole list for one unknown part. */
  parts: string[];
  at: string[];
  style: Record<string, unknown>;
}

/** A definition the parser accepted. */
export interface ParsedDefinitionRule {
  kind: 'definition';
  id: string;
  /** The at-rule's name in lower case, without the `@`. */
  atRule: string;
  /** The global name, absent for `@font-face`, whose name is its `fontFamily`. */
  name?: string;
  style?: Record<string, unknown>;
  blocks?: { selector: string; style: Record<string, unknown> }[];
}

export type ParsedRule = ParsedSelectorRule | ParsedDefinitionRule;

/** At most this many rules on one node. A later rule is refused with a reason. */
export const MAX_RULES_PER_NODE = 64;

const MAX_SELECTOR_LENGTH = 256;
const MAX_NESTING = 8;
/** One level of `at` is one level of nesting, so the same limit applies. */
const MAX_WRAPPERS = MAX_NESTING;

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const accept = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** True for a stored rule list. `rules` is also a legacy `<table>` attribute, which stays a string. */
export function isRuleList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** The node's stored rules, or an empty list for anything that is not a list. */
export function storedRulesOf(props: unknown): StoredRule[] {
  const rules = isPlainObject(props) ? props.rules : undefined;
  return isRuleList(rules) ? (rules as StoredRule[]) : [];
}

export const isDefinitionRule = (rule: StoredRule): rule is DefinitionRule => 'define' in rule;

// --- shared text checks ---------------------------------------------------

/** Why a selector or a prelude cannot hold this text, or null when it may. */
function refusedCharacters(text: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'it holds a control character';
  const banned = /[{}<;@\\]/.exec(text);
  if (banned) return `it holds a ${banned[0]}, which could end the rule or the style element`;
  if (text.includes('/*')) return 'it holds a comment';
  if (/url\(/i.test(text)) return 'it holds url(, and a selector or a condition cannot load anything';
  return null;
}

/**
 * Why the brackets, parentheses or quotes of this text do not balance, or null
 * when they do. Call only on text `refusedCharacters` passed: with no backslash
 * and no newline, a quote always closes at its next match.
 */
function refusedBalance(text: string): string | null {
  const closers: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return 'a quote is left open';
      i = close + 1;
      continue;
    }
    if (ch === '(' || ch === '[') {
      closers.push(ch === '(' ? ')' : ']');
      if (closers.length > MAX_NESTING) return `it nests deeper than ${MAX_NESTING} levels`;
    } else if ((ch === ')' || ch === ']') && closers.pop() !== ch) {
      return 'its brackets do not balance';
    }
    i++;
  }
  return closers.length > 0 ? 'a bracket is left open' : null;
}

/** One attribute selector, read rather than matched, so no spelling gets past it. */
const ATTRIBUTE =
  /\[ *(?:(?:\*|[^\s|=\]~^$*"'[]*)\|(?!=))?([^\s|=\]~^$*"'[]+) *(?:([~|^$*]?=) *("[^"]*"|'[^']*'|[^\s\]"']+) *(?:[iIsS] *)?)?\]/y;

const unquote = (text: string): string => (/^["']/.test(text) ? text.slice(1, -1) : text);

/**
 * Why this selector text names something it may not, or null. Reads every
 * attribute selector at any depth, so `:has(input[value^="a"])` counts too. Call
 * only on text that balances.
 */
function refusedNames(text: string): string | null {
  let outside = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = text.indexOf(ch, i + 1) + 1;
    } else if (ch === '[') {
      ATTRIBUTE.lastIndex = i;
      const match = ATTRIBUTE.exec(text);
      if (!match) return 'it holds an attribute selector that cannot be read';
      const [, name, operator, value] = match;
      if (operator && name.toLowerCase() === 'value') {
        return 'an attribute selector on value with an operator would read what a visitor types';
      }
      if (value && /^fc[-_]/i.test(unquote(value).trim())) {
        return 'names starting fc- or fc_ belong to the renderer and change on duplicate';
      }
      i = ATTRIBUTE.lastIndex;
    } else {
      outside += ch;
      i++;
    }
  }
  return /\.fc[-_]/i.test(outside) ? 'names starting fc- or fc_ belong to the renderer and change on duplicate' : null;
}

/** The text split on its top-level commas. Call only on text that balances. */
function splitList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = text.indexOf(ch, i + 1) + 1;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts;
}

// --- selectors ------------------------------------------------------------

/** The index just past the first compound of `part`, which starts with `&`. */
function endOfFirstCompound(part: string): number {
  let depth = 0;
  let i = 1;
  while (i < part.length) {
    const ch = part[i];
    if (ch === '"' || ch === "'") {
      i = part.indexOf(ch, i + 1) + 1;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~' || part.startsWith('||', i))) return i;
    i++;
  }
  return i;
}

/**
 * True when an accepted part's subject is inside the node rather than the node
 * itself, as in `&:hover h2`. Such a rule has to beat its target's Normal, which
 * it cannot while that Normal is inline.
 */
export function reachesInsideNode(part: string): boolean {
  return part.slice(endOfFirstCompound(part)).trim().length > 0;
}

/** Why one part of a selector list is refused, or null. */
function refusedPart(part: string): string | null {
  if (part[0] !== '&') return 'every part of a selector starts with &';
  if (part.length > MAX_SELECTOR_LENGTH) return `a selector part is longer than ${MAX_SELECTOR_LENGTH} characters`;
  // `&div` would be substituted into `.fc-a.fc-adiv`, a different class.
  if (!/^&(?:$|[:[.# >+~]|\|\|)/.test(part)) return '& must be followed by a pseudo-class, an attribute, a class, an id or a combinator';
  if (part.includes('&', 1)) return 'a selector holds & once, at its start';
  const next = part.slice(endOfFirstCompound(part)).trimStart();
  if (next[0] === '+' || next[0] === '~' || next.startsWith('||')) {
    return 'a sibling of the node is outside the node, so a selector cannot step to one from it';
  }
  return null;
}

/**
 * Parse a stored selector into its list parts. Pseudo-classes and pseudo-elements
 * are checked by shape, not against a list, so new CSS works without a code change.
 * Normalising is the job of what writes a rule: `:hover` here is refused, the panel
 * and the import write `&:hover`.
 */
export function parseSelector(text: unknown): Parsed<string[]> {
  if (typeof text !== 'string' || text.length === 0) return refuse('a rule needs a selector');
  const reason = refusedCharacters(text) ?? refusedBalance(text);
  if (reason) return refuse(reason);
  const parts = splitList(text).map((part, index) => (index === 0 ? part.trimEnd() : part.trim()));
  for (const part of parts) {
    const refused = refusedPart(part) ?? refusedNames(part);
    if (refused) return refuse(refused);
  }
  return accept(parts);
}

// --- at-rules -------------------------------------------------------------

/** Why a prelude's text is refused, or null. Checked like a selector. */
function refusedPrelude(text: string): string | null {
  if (text.length > MAX_SELECTOR_LENGTH) return `the condition is longer than ${MAX_SELECTOR_LENGTH} characters`;
  const reason = refusedCharacters(text) ?? refusedBalance(text);
  if (reason) return reason;
  return text.includes('&') ? 'a condition cannot hold &' : null;
}

/** The index of the `)` closing the `(` at `open`. Call only on text that balances. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") i = text.indexOf(ch, i + 1);
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Why an `@scope` prelude is refused, or null. Its selectors are read-only conditions. */
function refusedScope(prelude: string): string | null {
  let rest = prelude;
  const selectors: string[] = [];
  if (rest.startsWith('(')) {
    const end = closingParen(rest, 0);
    selectors.push(rest.slice(1, end));
    rest = rest.slice(end + 1).trim();
  }
  if (rest) {
    const to = /^to *\(/i.exec(rest);
    if (!to) return 'an @scope prelude is (root) to (limit)';
    const open = to[0].length - 1;
    const end = closingParen(rest, open);
    if (end !== rest.length - 1) return 'an @scope prelude is (root) to (limit)';
    selectors.push(rest.slice(open + 1, end));
  }
  for (const selector of selectors) {
    const refused = refusedNames(selector);
    if (refused) return refused;
  }
  return null;
}

const WRAPPER_NAMES: ReadonlySet<string> = new Set(['media', 'supports', 'container', 'scope', 'starting-style']);

/** One entry of a rule's `at`, or why it is refused. Only the allow list passes. */
export function parseWrapper(text: unknown): Parsed<string> {
  if (typeof text !== 'string') return refuse('a wrapper is an at-rule as text');
  const match = /^@([A-Za-z-]+)([\s\S]*)$/.exec(text.trim());
  if (!match) return refuse('a wrapper starts with an at-rule name');
  const name = match[1].toLowerCase();
  const prelude = match[2].trim();
  if (!WRAPPER_NAMES.has(name)) return refuse(`@${name} cannot wrap a rule`);
  const reason = refusedPrelude(prelude);
  if (reason) return refuse(reason);
  if (name === 'starting-style') return prelude ? refuse('@starting-style takes no condition') : accept(text.trim());
  if (name === 'scope') {
    const refused = refusedScope(prelude);
    return refused ? refuse(refused) : accept(text.trim());
  }
  return prelude ? accept(text.trim()) : refuse(`@${name} needs a condition`);
}

type DefinitionName = 'none' | 'plain' | 'dashed';

/** The definitions a node may hold. The name rule keeps a stored name off the editor's own. */
const DEFINITIONS: Readonly<Record<string, { name: DefinitionName; body: 'style' | 'blocks' }>> = {
  keyframes: { name: 'plain', body: 'blocks' },
  'font-face': { name: 'none', body: 'style' },
  'font-feature-values': { name: 'plain', body: 'blocks' },
  'font-palette-values': { name: 'dashed', body: 'style' },
  'counter-style': { name: 'plain', body: 'style' },
  property: { name: 'dashed', body: 'style' },
  'position-try': { name: 'dashed', body: 'style' },
};

const PLAIN_NAME = /^u-[a-z0-9-]+$/;
const DASHED_NAME = /^--u-[a-z0-9-]+$/;

const FEATURE_BLOCKS: ReadonlySet<string> = new Set([
  '@annotation',
  '@character-variant',
  '@historical-forms',
  '@ornaments',
  '@styleset',
  '@stylistic',
  '@swash',
]);

/**
 * What `syntax` of an `@property` may be. A constant lookup, never stored text: it
 * needs a `<`, so the emitter writes this constant rather than widen what a value
 * may hold. `<url>` and `<image>` are left out, they would only carry an address.
 */
export const PROPERTY_SYNTAXES: ReadonlySet<string> = new Set([
  '"*"',
  '"<angle>"',
  '"<color>"',
  '"<custom-ident>"',
  '"<integer>"',
  '"<length>"',
  '"<length-percentage>"',
  '"<number>"',
  '"<percentage>"',
  '"<resolution>"',
  '"<time>"',
  '"<transform-function>"',
  '"<transform-list>"',
]);

const keyframeSelector = (text: string): boolean =>
  text.split(',').every((part) => /^(?:from|to|(?:\d{1,2}(?:\.\d+)?|100(?:\.0+)?)%)$/i.test(part.trim()));

function refusedBlockSelector(atRule: string, selector: unknown): string | null {
  if (typeof selector !== 'string') return 'a block needs a selector';
  if (atRule === 'keyframes') return keyframeSelector(selector) ? null : 'a keyframe is from, to or a percentage';
  return FEATURE_BLOCKS.has(selector.toLowerCase()) ? null : `${selector} is not a font feature block`;
}

/** Why a definition's body is refused, beyond what every value is checked for. */
function refusedDescriptors(atRule: string, style: Record<string, unknown>): string | null {
  if (atRule === 'font-face') {
    const family = style.fontFamily;
    if (typeof family !== 'string' || !PLAIN_NAME.test(unquote(family.trim()))) return '@font-face needs a fontFamily starting u-';
  }
  if (atRule === 'property') {
    if (typeof style.syntax !== 'string' || !PROPERTY_SYNTAXES.has(style.syntax)) return 'the syntax of @property comes from a fixed list';
    if (style.inherits !== undefined && style.inherits !== 'true' && style.inherits !== 'false') return 'inherits is true or false';
  }
  return null;
}

function parseDefinition(rule: Record<string, unknown>, id: string): Parsed<ParsedDefinitionRule> {
  if (typeof rule.define !== 'string') return refuse('a definition is an at-rule as text');
  const match = /^@([A-Za-z-]+)(?: +(\S+))?$/.exec(rule.define.trim());
  const atRule = match?.[1].toLowerCase() ?? '';
  const known = Object.prototype.hasOwnProperty.call(DEFINITIONS, atRule) ? DEFINITIONS[atRule] : undefined;
  if (!match || !known) return refuse(`${rule.define.trim().split(/\s/)[0] || 'this'} cannot be stored on a node`);
  const name = match[2];
  if (rule.at !== undefined) return refuse('a definition has no wrapper');
  if (known.name === 'none' && name) return refuse(`@${atRule} takes no name`);
  if (known.name === 'plain' && !PLAIN_NAME.test(name ?? '')) return refuse(`@${atRule} needs a name starting u-`);
  if (known.name === 'dashed' && !DASHED_NAME.test(name ?? '')) return refuse(`@${atRule} needs a name starting --u-`);

  if (known.body === 'style') {
    if (rule.blocks !== undefined) return refuse(`@${atRule} takes descriptors, not blocks`);
    if (!isPlainObject(rule.style)) return refuse(`@${atRule} needs descriptors`);
    const reason = refusedDescriptors(atRule, rule.style) ?? refusedBody(rule.style, { maps: false, skip: atRule === 'property' ? 'syntax' : undefined });
    if (reason) return refuse(reason);
    return accept({ kind: 'definition', id, atRule, ...(name ? { name } : {}), style: rule.style });
  }

  if (rule.style !== undefined) return refuse(`@${atRule} takes blocks, not descriptors`);
  if (!Array.isArray(rule.blocks) || rule.blocks.length === 0) return refuse(`@${atRule} needs blocks`);
  for (const block of rule.blocks as unknown[]) {
    if (!isPlainObject(block)) return refuse('a block needs a selector and a style');
    const reason = refusedBlockSelector(atRule, block.selector) ?? refusedBody(block.style, { maps: false });
    if (reason) return refuse(reason);
  }
  return accept({ kind: 'definition', id, atRule, name, blocks: rule.blocks as ParsedDefinitionRule['blocks'] });
}

// --- values and addresses -------------------------------------------------

/** Functions that fetch what they are given, in lower case. */
const FETCHING: ReadonlySet<string> = new Set(['url', 'image-set', '-webkit-image-set', 'image', 'src', 'cross-fade', '-webkit-cross-fade']);

/**
 * Any name ending like one. Refusing `--src()` or `-moz-image-set()` costs nothing
 * real, and a custom function can return an address the text does not show.
 */
const FETCHING_TAIL = /(?:url|image-set|image|src|cross-fade)$/;

/**
 * What may stand inside a fetching function besides its addresses. A whitelist,
 * because `image-set(var(--x) 1x)` fetches a bare string held elsewhere, so
 * anything that fills in a value later cannot be proven to be no address.
 */
const INSIDE_FETCHING = /^(?:type|calc|rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|(?:repeating-)?(?:linear|radial|conic)-gradient)$/;

const ADDRESS_REFUSAL = 'a rule cannot hold an external address: use a site path with one leading / or data:';

/**
 * True for an address a rule may hold: a site path with one leading `/`, or
 * `data:`. Compared the way the URL parser reads it, which removes tabs and
 * newlines anywhere, so `/` + newline + `/host` is the two slashes it becomes.
 */
function isAllowedAddress(raw: string): boolean {
  const address = raw.replace(/[\t\n\r\f]/g, '').trim();
  return /^\/(?!\/)/.test(address) || /^data:/i.test(address);
}

/** The name standing directly before the `(` at `open`, in lower case. */
function functionName(text: string, open: number): string {
  let start = open;
  while (start > 0 && /[A-Za-z0-9_\-\u0080-￿]/.test(text[start - 1])) start--;
  return text.slice(start, open).toLowerCase();
}

type ValueProblem = { kind: 'shape' | 'address'; reason: string };

const shapeProblem = (reason: string): ValueProblem => ({ kind: 'shape', reason });
const addressProblem = (reason: string = ADDRESS_REFUSAL): ValueProblem => ({ kind: 'address', reason });

/** Whether a fetching function's name is one that can be read, and may stand here. */
function functionProblem(name: string, insideFetching: boolean): ValueProblem | null {
  if (FETCHING.has(name)) return null;
  // A non-ASCII name is read differently by browsers and by the specification.
  if (FETCHING_TAIL.test(name.replace(/[^\x00-\x7f]/g, ''))) return addressProblem();
  if (insideFetching && !INSIDE_FETCHING.test(name)) {
    return addressProblem(`${name || 'a block'}() inside a function that fetches cannot be proven to be no address`);
  }
  return null;
}

/**
 * Read a value the way the browser tokenizes it, and report the first thing that
 * stops it being contained in its declaration or that holds an external address.
 * Plain strings are text: `content:"https://example.com"` is fine. Call only on
 * text with no backslash, because an escape can spell any of these names.
 *
 * A `;` counts as data only inside a string or an unquoted url(), as in
 * isContainedValue (responsiveCss.ts). `<` and `>` count as data only in a string,
 * where the emitter owns the output.
 */
function scanValue(text: string): ValueProblem | null {
  const stack: string[] = [];
  // A count, not a walk of the stack: a stored value can be any length.
  let fetching = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return shapeProblem('a quote is left open');
      if (fetching > 0 && stack[stack.length - 1] !== 'type' && !isAllowedAddress(text.slice(i + 1, close))) return addressProblem();
      i = close + 1;
    } else if (ch === '(') {
      const name = functionName(text, i);
      const problem = functionProblem(name, fetching > 0);
      if (problem) return problem;
      let body = i + 1;
      while (text[body] === ' ') body++;
      if (name === 'url' && text[body] !== '"' && text[body] !== "'") {
        const end = text.indexOf(')', body);
        if (end === -1) return addressProblem();
        const address = text.slice(body, end).trim();
        if (/["'(\s]/.test(address)) return shapeProblem('a url() does not parse');
        if (!isAllowedAddress(address)) return addressProblem();
        i = end + 1;
      } else {
        stack.push(name);
        if (FETCHING.has(name)) fetching++;
        i++;
      }
    } else if (ch === '[') {
      stack.push('[');
      i++;
    } else if (ch === ')' || ch === ']') {
      const open = stack.pop();
      if (open === undefined || (open === '[') !== (ch === ']')) return shapeProblem('its brackets do not balance');
      if (FETCHING.has(open)) fetching--;
      i++;
    } else if (ch === ';') {
      return shapeProblem('a ; outside a string ends the declaration');
    } else if (ch === '<' || ch === '>') {
      return shapeProblem(`a ${ch} outside a string could end the style element`);
    } else {
      i++;
    }
  }
  return stack.length > 0 ? shapeProblem('a bracket is left open') : null;
}

/** Why a value's text is refused, or null. A tab or newline is left to the emitter to normalise. */
function refusedValueText(text: string): string | null {
  if (UNSAFE_VALUE.test(text)) return 'the value holds script-capable or import-capable CSS';
  if (/[{}\\\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) return 'the value holds a brace, a backslash or a control character';
  return scanValue(text)?.reason ?? null;
}

function refusedScalar(key: string, value: unknown): string | null {
  if (value !== null && typeof value === 'object') return `${key} holds something other than a value`;
  const text = cssValueText(key, value);
  return text === undefined ? null : refusedValueText(text);
}

/** Why a rule's declarations are refused, or null. `skip` names a key checked elsewhere. */
function refusedBody(style: unknown, options: { maps: boolean; skip?: string }): string | null {
  if (!isPlainObject(style)) return 'a rule needs a style';
  for (const [key, stored] of Object.entries(style)) {
    if (!SAFE_PROPERTY.test(key)) return `${key} is not a property name`;
    if (key === options.skip) continue;
    if (!isStyleMap(stored)) {
      const reason = refusedScalar(key, stored);
      if (reason) return reason;
      continue;
    }
    if (!options.maps) return 'a definition has no breakpoints, so it holds plain values';
    for (const value of Object.values(stored)) {
      const reason = refusedScalar(key, value);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * True when a plain style value could give a rule an external address through
 * `var()`: a custom property holding a fetching function that cannot be proven to
 * hold only a site path or `data:`. Normal is not filtered for escapes the way a
 * rule is, and `\75rl(...)` is a real url(), so an escape or a comment proves
 * nothing and counts. Called at emission for every `--*` value of a page with an
 * authored rule, which needs no rule on that node.
 */
export function hasExternalAddress(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.includes('\\') || value.includes('/*')) return true;
  const problem = scanValue(value);
  if (problem === null) return false;
  // A value left open is closed by the end of an inline style, so a broken shape
  // proves nothing either as soon as a fetching name is in it.
  return problem.kind === 'address' || /(?:url|image-set|image|src|cross-fade)\s*\(/i.test(value);
}

// --- whole rules ----------------------------------------------------------

const RULE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function parseSelectorRule(rule: Record<string, unknown>, id: string): Parsed<ParsedSelectorRule> {
  const selector = parseSelector(rule.selector);
  if (!selector.ok) return selector;
  if (rule.at !== undefined && !Array.isArray(rule.at)) return refuse('at is a list of wrappers');
  const wrappers: unknown[] = rule.at ?? [];
  if (wrappers.length > MAX_WRAPPERS) return refuse(`a rule has at most ${MAX_WRAPPERS} wrappers`);
  const at: string[] = [];
  for (const entry of wrappers) {
    const wrapper = parseWrapper(entry);
    if (!wrapper.ok) return wrapper;
    at.push(wrapper.value);
  }
  const reason = refusedBody(rule.style, { maps: true });
  if (reason) return refuse(reason);
  return accept({ kind: 'selector', id, parts: selector.value, at, style: rule.style as Record<string, unknown> });
}

/** One stored rule, whole or refused. Untrusted input of any shape is fine here. */
export function parseRule(rule: unknown): Parsed<ParsedRule> {
  if (!isPlainObject(rule)) return refuse('a rule is an object');
  const { id } = rule;
  if (typeof id !== 'string' || !RULE_ID.test(id)) return refuse('a rule needs a short id');
  const isSelector = rule.selector !== undefined;
  const isDefinition = rule.define !== undefined;
  if (isSelector === isDefinition) return refuse('a rule is either a selector or a definition');
  return isSelector ? parseSelectorRule(rule, id) : parseDefinition(rule, id);
}

/** A stored rule that will not reach a stylesheet, and why. */
export interface RefusedRule {
  index: number;
  rule: unknown;
  reason: string;
}

export interface ReadRules {
  rules: ParsedRule[];
  refused: RefusedRule[];
}

/**
 * Every rule of a node, with those that do not parse set aside with their reason.
 * Anything but a list is no rules at all, so a `<table rules="all">` stays an
 * attribute. Beyond the node's cap, later rules are refused.
 */
export function readRules(props: unknown): ReadRules {
  const stored = isPlainObject(props) ? props.rules : undefined;
  const result: ReadRules = { rules: [], refused: [] };
  if (!isRuleList(stored)) return result;
  const seen = new Set<string>();
  stored.forEach((rule, index) => {
    const parsed = parseRule(rule);
    const refused = (reason: string) => result.refused.push({ index, rule, reason });
    if (!parsed.ok) refused(parsed.reason);
    else if (seen.has(parsed.value.id)) refused('another rule on this node has the same id');
    else if (result.rules.length >= MAX_RULES_PER_NODE) refused(`a node holds at most ${MAX_RULES_PER_NODE} rules`);
    else {
      seen.add(parsed.value.id);
      result.rules.push(parsed.value);
    }
  });
  return result;
}
