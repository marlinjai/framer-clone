// src/lib/responsive/responsiveCss.ts
//
// The published page's responsive stylesheet. The editor resolves a node's
// responsive styles per breakpoint with `resolveCascade` (cascade.ts); the
// published page cannot pick one breakpoint at render time, so it emits real
// CSS that cascades the same way. See
// docs/plans/2026-10-23-breakpoint-style-inheritance.md, decision 5.
//
// Output, for breakpoints Desktop (1200) > Tablet (810) > Phone (390):
//
//   .fc-a.fc-a{color:red;font-size:16px}            the largest breakpoint (base)
//   @media (max-width:1199.98px){.fc-a.fc-a{...}}   Tablet's own overrides
//   @media (max-width:809.98px){.fc-a.fc-a{...}}    Phone's own overrides
//
// A narrower query comes later in the sheet, so where both match it wins, and a
// breakpoint without its own value falls through to the next larger one, then
// to the base: exactly `resolveCascade`. The query width is the next larger
// breakpoint's min width minus 0.02px (not 1px), so a fractional viewport width
// such as 809.5px still lands on the breakpoint `pickBreakpoint` would choose.
//
// After those come the authored rules of `props.rules` (src/lib/rules/rules.ts),
// grouped by rule rather than by breakpoint, so Pressed stays above Hover at every
// width. Each rule's breakpoint query is outermost, then its `at`, then the
// selector:
//
//   @media (hover:hover) and (pointer:fine){
//   .fc_r-a.fc_r-a:hover{color:blue}
//   }
//   @media (max-width:1199.98px){
//   @media (hover:hover) and (pointer:fine){
//   .fc_r-a.fc_r-a:hover{color:green}
//   }
//   }
//
// PURE: no React, no MST. Values are serialized the way React serializes an
// inline style (camelCase to kebab-case, px on non-zero numbers except the
// unitless properties). The sheet refuses more than an inline style does: a value
// or property name that could break out of its declaration (and so out of the
// rule or the <style> element) is not emitted, which is why applyResponsiveStyles
// leaves such a value inline rather than moving it. A `;` is not such a value by
// itself: inside a quoted string or a url() it is data, as in
// `url("data:image/png;base64,...")`, and isContainedValue tells the two apart. A
// CSS escape inside a string is data too, as in `content:"\201C"`.
//
// Definitions come first in the sheet, before every Normal block: `@keyframes`,
// `@font-face` and the rest of the list in rules.ts. They have no breakpoint axis
// and no wrapper, and applyResponsiveStyles has already removed duplicates.
//
// Rules arrive here parsed, which the type says, and applyResponsiveStyles is what
// reads stored rules for the page. A type is erased at run time and selectors are
// written raw, so isWritableRule and isWritableDefinition check them again here,
// and the finished sheet must hold no `<`. A rule is emitted whole or not at all.

import type { ParsedDefinitionRule, ParsedSelectorRule } from '@/lib/rules/rules';
import { largestFirst, resolveCascade, type BreakpointRef } from './cascade';

/** At most this many emitted rules on one page, counted after rows share a rule class. */
export const MAX_RULES_PER_PAGE = 2000;
/** At most this much rule text on one page: one `data:` value can outweigh any rule count. */
export const MAX_RULE_BYTES_PER_PAGE = 256 * 1024;

/**
 * Properties React leaves unitless when given a number. Copied from React 19's
 * `unitlessNumbers` (react-dom server and client agree on this set).
 */
const UNITLESS_NUMBERS: ReadonlySet<string> = new Set(
  (
    'animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex ' +
    'boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative ' +
    'flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan ' +
    'gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom ' +
    'fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity ' +
    'strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount ' +
    'msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn ' +
    'msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup ' +
    'WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive ' +
    'WebkitFlexShrink WebkitLineClamp'
  ).split(' '),
);

/** A style key React accepts: a camelCase name or a custom property. */
export const SAFE_PROPERTY = /^(?:[A-Za-z][A-Za-z0-9]*|--[A-Za-z0-9_-]+)$/;

/**
 * Characters that let a value escape its declaration wherever they appear,
 * quoted or not: `{` `}` open or close a rule, and control characters have no
 * place in a value. `;` is not here, because it depends on where it stands (see
 * isContainedValue), and neither is what sheetValueText handles by position: a
 * tab or a newline, `<`, `>` and the backslash.
 */
const BREAKOUT_CHARS = /[{}\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

/**
 * How the browser reads the `(` at `open`, when no quote follows it: as the
 * start of an unquoted url token, or as a plain block. It is a url token only
 * when `url` is a name of its own: a name character, `#` or `@` before it pulls
 * it into a longer identifier, a dimension, a hash or an at-keyword, and then
 * the url rules do not apply. A non-ASCII character is 'ambiguous': browsers
 * and the CSS specification differ on which ones are name characters, and the
 * two readings end the token in different places, so neither can be trusted.
 */
function parenKind(text: string, open: number): 'url' | 'block' | 'ambiguous' {
  if (open < 3 || text.slice(open - 3, open).toLowerCase() !== 'url') return 'block';
  if (open === 3) return 'url';
  const before = text[open - 4];
  if (before >= '\u0080') return 'ambiguous';
  return /[A-Za-z0-9_#@-]/.test(before) ? 'block' : 'url';
}

/**
 * The index just past an unquoted url( body starting at `start`, or -1 when it
 * is not one clean url token. A quote, a `(` or a space before the end makes the
 * browser read a bad url, and without a `)` it would swallow what follows.
 */
function endOfUnquotedUrl(text: string, start: number): number {
  const end = text.indexOf(')', start);
  if (end === -1) return -1;
  return /["'(\s]/.test(text.slice(start, end).trimEnd()) ? -1 : end + 1;
}

/**
 * The index just past the quoted string opening at `start`, or -1 when it never
 * closes. A backslash hides the character after it, so an escaped quote does not
 * end the string, and one last in the text leaves it open.
 */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === text[start]) return i + 1;
  }
  return -1;
}

/** The text with its CSS escapes resolved, the way the browser reads it, so an escape cannot hide what a check looks for. */
function withoutEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|([\s\S]))/g, (_, hex: string | undefined, ch: string) => {
    if (!hex) return ch;
    const code = parseInt(hex, 16);
    return code === 0 || code > 0x10ffff ? '\ufffd' : String.fromCodePoint(code);
  });
}

/** What a CSS value holds, read the way the browser tokenizes it. */
export interface CssValueScan {
  /**
   * True when the value stays inside its declaration. A `;` counts as data only
   * inside a string or an unquoted url(). Anywhere else it ends the declaration,
   * so the value is refused. A string, block or url() left open is refused too,
   * because the browser would carry on through the `;` and `}` that follow it and
   * swallow the rest of the rule.
   */
  contained: boolean;
  /** Every address: each url(), quoted or not, and each string inside image-set(), with its escapes resolved. */
  urls: string[];
  /** Every string, without its quotes, with its escapes resolved. */
  strings: string[];
  /** A var() inside image-set(): an address no check can read here. */
  indirect: boolean;
}

/** The name of the function whose `(` is at `open`, lower-cased; '' for a plain block. */
function functionName(text: string, open: number): string {
  let start = open;
  while (start > 0 && /[A-Za-z0-9_-]/.test(text[start - 1])) start--;
  return text.slice(start, open).toLowerCase();
}

const isImageSet = (name: string) => name === 'image-set' || name === '-webkit-image-set';

/**
 * Read a value token by token. Call only on text with no backslash outside a
 * string and no raw newline in one, which this reader would not see through: the
 * AI validator's breakout check gives that, and so does sheetValueText. Everything
 * that asks where a value points goes through
 * here, because a pattern over the raw text can start inside a string and read a
 * different value than the browser does. When `contained` is false the rest of the
 * fields stop at that point.
 */
export function scanCssValue(text: string): CssValueScan {
  const scan: CssValueScan = { contained: false, urls: [], strings: [], indirect: false };
  const open: { closer: string; name: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = endOfString(text, i);
      if (end === -1) return scan;
      const body = withoutEscapes(text.slice(i + 1, end - 1));
      const inside = open[open.length - 1]?.name ?? '';
      scan.strings.push(body);
      if (inside === 'url' || isImageSet(inside)) scan.urls.push(body.trim());
      i = end;
    } else if (ch === '(') {
      let body = i + 1;
      while (text[body] === ' ') body++;
      const quoted = text[body] === '"' || text[body] === "'";
      const kind = quoted ? 'block' : parenKind(text, i);
      if (kind === 'ambiguous') return scan;
      if (kind === 'url') {
        const end = endOfUnquotedUrl(text, body);
        if (end === -1) return scan;
        scan.urls.push(text.slice(body, end - 1).trim());
        i = end;
      } else {
        const name = functionName(text, i);
        if (name === 'var' && open.some((block) => isImageSet(block.name))) scan.indirect = true;
        open.push({ closer: ')', name });
        i++;
      }
    } else if (ch === '[') {
      open.push({ closer: ']', name: '' });
      i++;
    } else if (ch === ')' || ch === ']') {
      if (open.pop()?.closer !== ch) return scan;
      i++;
    } else if (ch === ';') {
      return scan;
    } else {
      i++;
    }
  }
  scan.contained = open.length === 0;
  return scan;
}

/** Whether a value stays inside its declaration. See CssValueScan.contained. */
export function isContainedValue(text: string): boolean {
  return scanCssValue(text).contained;
}

/** Every address in a value: the one list the AI generator and review judge. */
export function cssUrlsIn(text: string): string[] {
  return scanCssValue(text).urls;
}

/** Script-capable or import-capable CSS, and comments, which hide a `;` from isContainedValue. */
export const UNSAFE_VALUE = /javascript:|vbscript:|expression\s*\(|<\s*\/?\s*script|@import|behavior\s*:|-moz-binding|\/\*/i;

/**
 * A string's body as sheet text, or null. A hex escape stays, with the space that
 * ends it if it has one. An escaped `<` loses its backslash for an escape the
 * sheet can hold. A backslash before a newline continues the string in CSS, which
 * nothing needs, so it is refused.
 */
function sheetStringBody(body: string): string | null {
  let refused = false;
  const out = body.replace(/\\([0-9a-fA-F]{1,6})(\r\n|[ \t\n\r\f])?|\\([\s\S])|\r\n|[\n\r\f]|</g, (match, hex: string | undefined, space: string | undefined, ch: string | undefined) => {
    if (hex) return `\\${hex}${space ? ' ' : ''}`;
    if (ch === undefined) return match === '<' ? '\\3c ' : '\\a ';
    if (/[\n\r\f]/.test(ch)) refused = true;
    return ch === '<' ? '\\3c ' : match;
  });
  return refused ? null : out;
}

/**
 * The text the sheet holds for a value, or null when it cannot hold it. Where the
 * emitter owns the output it widens what a value may be: inside a string `<` is
 * written `\3c ` and a newline `\a `, and a tab or newline between tokens becomes a
 * space. So the output never holds a `<`, which matters because the sheet is
 * written raw and CSS quoting does not protect the <style> element. Everything is
 * then checked as written, by isContainedValue, and UNSAFE_VALUE also reads the
 * text with its escapes resolved. A backslash is an escape only inside a string.
 * Outside one it is refused: an escaped name can spell `url` where the reader would
 * not see it, and last in the value it would hide what the sheet adds. Stored text
 * with no tab, newline or `<` comes back unchanged.
 */
function sheetValueText(text: string): string | null {
  if (BREAKOUT_CHARS.test(text) || UNSAFE_VALUE.test(text) || UNSAFE_VALUE.test(withoutEscapes(text))) return null;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = endOfString(text, i);
      if (end === -1) return null;
      const body = sheetStringBody(text.slice(i + 1, end - 1));
      if (body === null) return null;
      out += ch + body + ch;
      i = end;
    } else if (ch === '<' || ch === '>' || ch === '\\') {
      return null;
    } else {
      out += ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' ? ' ' : ch;
      i++;
    }
  }
  return isContainedValue(out) ? out : null;
}

/** A camelCase style key as a CSS property name, exactly as React writes it. */
export function cssPropertyName(key: string): string {
  if (key.startsWith('--')) return key;
  return key.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^ms-/, '-ms-');
}

/** A CSS property name as a style key, the reverse of cssPropertyName. */
export function cssStyleKey(property: string): string {
  if (property.startsWith('--')) return property;
  return property.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * A style value as CSS text, exactly as React serializes an inline style:
 * non-zero numbers get `px` unless the property is unitless (or a custom
 * property), strings are trimmed. Returns undefined for a value React would
 * drop (null, boolean, empty, non-finite number) or that is not a scalar.
 */
export function cssValueText(key: string, value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (value === 0 || key.startsWith('--') || UNITLESS_NUMBERS.has(key)) return String(value);
    return `${value}px`;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/**
 * The one safety rule for a declaration: what makes the published stylesheet
 * drop it, and so what the properties panel refuses before it is stored. `text`
 * is the value as cssValueText gives it.
 */
export function unsafeDeclaration(key: string, text: string | undefined): 'unsafe-property' | 'unsafe-value' | null {
  if (!SAFE_PROPERTY.test(key)) return 'unsafe-property';
  if (text === undefined) return null;
  return sheetValueText(text) === null ? 'unsafe-value' : null;
}

/** Why a declaration was dropped; reported once per page through `onDrop`. */
export interface DroppedDeclaration {
  className: string;
  property: string;
  reason: 'unsafe-property' | 'unsafe-value';
  /** Set when the declaration stays inline: the breakpoints of a map it loses by that. */
  lostBreakpoints?: string[];
}

/**
 * One `prop:value` declaration, or null when the property or value is unsafe
 * (reported through `onDrop`) or React would not render the value at all.
 */
function declaration(
  className: string,
  key: string,
  value: unknown,
  onDrop: (d: DroppedDeclaration) => void,
): string | null {
  const text = SAFE_PROPERTY.test(key) ? cssValueText(key, value) : undefined;
  const reason = unsafeDeclaration(key, text);
  if (reason) {
    onDrop({ className, property: key, reason });
    return null;
  }
  return text === undefined ? null : `${cssPropertyName(key)}:${sheetValueText(text)}`;
}

/** One node's styles, keyed by its (already safe) class name. */
export interface ResponsiveRuleInput {
  /** A class name of the shape `fc-[A-Za-z0-9_-]+`, used as the selector. */
  className: string;
  /**
   * The node's full style object in its stored order: plain values and
   * responsive maps (`{ base, <breakpointId>: value }`) side by side. Plain
   * values apply at every width, like a map holding only `base`.
   */
  style: Record<string, unknown>;
}

/** One rule class and its parsed rules, in stored order. */
export interface AuthoredRulesInput {
  /** A class name of the shape `fc_r-[A-Za-z0-9_-]+`, which stands in for `&`. */
  className: string;
  rules: readonly ParsedSelectorRule[];
}

/** A rule left out of the sheet whole, and why; reported once per page through `onDropRule`. */
export interface DroppedRule {
  className: string;
  ruleId: string;
  reason: string;
}

/** One definition and the node it sits on, which is only there to name it in a report. */
export interface DefinitionInput {
  node: string;
  rule: ParsedDefinitionRule;
}

export interface BuildResponsiveCssOptions {
  /** Called for every declaration dropped as unsafe. */
  onDrop?: (dropped: DroppedDeclaration) => void;
  /** Definitions, deduped, in walk order. They precede every Normal block. */
  definitions?: readonly DefinitionInput[];
  /** Authored rules, in walk order. They follow every Normal block. */
  authored?: readonly AuthoredRulesInput[];
  /** Adds FIELD_SIZING_GUARD: true on a page holding a stored rule or definition. */
  fieldGuard?: boolean;
  /** Called for every definition or authored rule left out of the sheet. */
  onDropRule?: (dropped: DroppedRule) => void;
}

/** True when a style value is a responsive map rather than a scalar. */
export function isStyleMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const SAFE_CLASS = /^fc-[A-Za-z0-9_-]+$/;
const SAFE_RULE_CLASS = /^fc_r-[A-Za-z0-9_-]+$/;

/**
 * The max-width (px) of a breakpoint's media query: just below the next
 * larger breakpoint's min width, rounded to two decimals so float noise never
 * reaches the sheet.
 */
export function maxWidthBelow(largerMinWidth: number): string {
  return String(Number((largerMinWidth - 0.02).toFixed(2)));
}

/**
 * The declarations for one node at one breakpoint. At the largest breakpoint
 * (index 0) that is the resolved value (its own, a legacy primary-id value, or
 * `base`); at a smaller one only the values set on that breakpoint itself,
 * since everything else is inherited through the cascade of the sheet.
 */
function declarationsAt(
  rule: ResponsiveRuleInput,
  ordered: readonly BreakpointRef[],
  index: number,
  onDrop: (d: DroppedDeclaration) => void,
): string[] {
  const out: string[] = [];
  const breakpointId = ordered[index]?.id;
  for (const [key, stored] of Object.entries(rule.style)) {
    let value: unknown;
    if (isStyleMap(stored)) {
      const resolved = resolveCascade(stored, breakpointId, ordered);
      if (index > 0 && resolved.source.kind !== 'own') continue;
      value = resolved.value;
      // A map with no known breakpoint key and no `base` resolves to nothing:
      // the editor shows nothing for it either.
    } else {
      if (index > 0) continue;
      value = stored;
    }
    const decl = declaration(rule.className, key, value, onDrop);
    if (decl) out.push(decl);
  }
  return out;
}

const mediaBelow = (largerMinWidth: number): string => `@media (max-width:${maxWidthBelow(largerMinWidth)}px)`;

/** One emitted rule, with the conditions around it from the outside in. */
interface RuleBlock {
  wrappers: readonly string[];
  text: string;
}

/**
 * What no selector part or wrapper may hold, whoever built it. A constant check
 * and not the parser: this module cannot import rules.ts as a value, because
 * rules.ts imports from here. It is the guard behind the parser, so it stops text
 * from leaving the rule or the <style> element and leaves meaning to the parser.
 */
const UNSAFE_RULE_TEXT = /[<{};\\\u0000-\u001f\u007f]|\/\*/;

const isSafeRuleText = (text: unknown): text is string => typeof text === 'string' && !UNSAFE_RULE_TEXT.test(text);

/** True when a rule's selectors and wrappers can be written raw into the sheet. */
function isWritableRule(rule: ParsedSelectorRule): boolean {
  const { parts, at, style } = rule;
  return (
    Array.isArray(parts) &&
    parts.every((part) => isSafeRuleText(part) && part.startsWith('&')) &&
    Array.isArray(at) &&
    at.every(isSafeRuleText) &&
    isStyleMap(style)
  );
}

/**
 * Every block of one rule: its base, then each breakpoint's own values, one block
 * per part of a selector list, because a browser throws away a whole list for one
 * part it does not know. The parser and the sheet check values apart, so null
 * means the sheet refused one, and the rule is dropped rather than partly applied.
 */
function blocksOfRule(
  className: string,
  rule: ParsedSelectorRule,
  ordered: readonly BreakpointRef[],
): { blocks: RuleBlock[] } | { refused: string } {
  const blocks: RuleBlock[] = [];
  const node = `.${className}.${className}`;
  let refused: string | undefined;
  const widths = Math.max(ordered.length, 1);
  for (let index = 0; index < widths; index++) {
    const decls = declarationsAt({ className, style: rule.style }, ordered, index, (d) => {
      refused ??= d.property;
    });
    if (decls.length === 0) continue;
    const wrappers = index === 0 ? rule.at : [mediaBelow(ordered[index - 1].minWidth), ...rule.at];
    // Every part starts with `&`, and the parser allows no other.
    for (const part of rule.parts) blocks.push({ wrappers, text: `${node}${part.slice(1)}{${decls.join(';')}}` });
  }
  return refused === undefined ? { blocks } : { refused: `the stylesheet refuses its ${refused}` };
}

const sameWrappers = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((wrapper, index) => wrapper === b[index]);

/** The blocks as text. Adjacent blocks with identical wrappers merge, which keeps order and saves bytes. */
function serializeBlocks(blocks: readonly RuleBlock[]): string {
  const groups: { wrappers: readonly string[]; texts: string[] }[] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (last && sameWrappers(last.wrappers, block.wrappers)) last.texts.push(block.text);
    else groups.push({ wrappers: block.wrappers, texts: [block.text] });
  }
  return groups
    .map(({ wrappers, texts }) => [...wrappers.map((wrapper) => `${wrapper}{`), ...texts, ...wrappers.map(() => '}')].join('\n'))
    .join('\n');
}

const ENCODER = new TextEncoder();
const textBytes = (text: string): number => ENCODER.encode(text).length;

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

/** The name standing directly before the `(` at `open`, in lower case, non-ASCII characters included. */
export function rawFunctionName(text: string, open: number): string {
  let start = open;
  while (start > 0 && /[A-Za-z0-9_\-\u0080-￿]/.test(text[start - 1])) start--;
  return text.slice(start, open).toLowerCase();
}

export type ValueProblem = { kind: 'shape' | 'address'; reason: string };

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
export function scanValue(text: string): ValueProblem | null {
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
      const name = rawFunctionName(text, i);
      const problem = functionProblem(name, fetching > 0);
      if (problem) return problem;
      let body = i + 1;
      while (text[body] === ' ') body++;
      if (name === 'url' && text[body] !== '"' && text[body] !== "'") {
        const end = text.indexOf(')', body);
        if (end === -1) return addressProblem();
        const address = text.slice(body, end).trim();
        if (/["'(\s]/.test(address)) return shapeProblem('a url() does not parse');
        const markup = /[<>]/.exec(address);
        if (markup) return shapeProblem(`a ${markup[0]} outside a string could end the style element`);
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

/**
 * The last line of a sheet on a page with a stored rule or definition. A control
 * sized by its text turns what a visitor types into a width, one stored font per
 * character can magnify it, and a container query can read it, with no selector
 * touching `value`. A fixed width carries nothing, whichever threshold is chosen.
 * This is a constant on purpose: it needs no parsing and it cannot vary per tenant.
 * It lands in the page's own sheet only, because the canvas shares a document with
 * the editor's own fields. It does not reach a shadow tree and a stored rule could
 * outrank it, so rules.ts refuses `fieldSizing` in a rule and setsFieldSizing drops
 * it from Normal. See the plan: this narrows the route and an enforced Content
 * Security Policy closes it.
 */
export const FIELD_SIZING_GUARD = 'input,textarea,select{field-sizing:fixed!important}';

/**
 * True when a plain style entry would set `field-sizing` inline, where it would
 * beat the guard: under its own key, or smuggled after a `;` in another value,
 * escapes resolved. A mention that stays inside its declaration sets nothing, as in
 * `transition:field-sizing 1s` or `content:"field-sizing"`.
 */
export function setsFieldSizing(key: string, value: unknown): boolean {
  if (key === 'fieldSizing') return true;
  if (typeof value !== 'string') return false;
  return /field-sizing/i.test(withoutEscapes(value)) && !isContainedValue(value);
}

/**
 * What `syntax` of an `@property` may be, exactly as stored. A constant, never
 * stored text: definitionText writes this list's own entry rather than the value
 * it was given, which is how a `<` reaches a descriptor without widening what a
 * value may hold. `<url>` and `<image>` are left out, they would only carry an
 * address.
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

/** A syntax as the sheet holds it. CSS reads `\3c ` in a string as a `<`, and the sheet never holds one. */
const propertySyntaxText = (stored: unknown): string | null =>
  typeof stored === 'string' && PROPERTY_SYNTAXES.has(stored) ? stored.replace('<', '\\3c ') : null;

const DEFINITION_AT_RULES: ReadonlySet<string> = new Set([
  'keyframes',
  'font-face',
  'font-feature-values',
  'font-palette-values',
  'counter-style',
  'property',
  'position-try',
]);

/** At most this many blocks in one definition, which is more than a real keyframe list or feature table holds. */
export const MAX_DEFINITION_BLOCKS = 256;

/** At-rules holding real properties, where a number means pixels as in a style. In the others it stays a number. */
const PROPERTY_BODIES: ReadonlySet<string> = new Set(['keyframes', 'position-try']);

const DEFINITION_NAME = /^(?:--)?u-[a-z0-9-]+$/;
const FONT_FACE_FAMILY = /^(?:u-[a-z0-9-]+|"u-[a-z0-9-]+"|'u-[a-z0-9-]+')$/;
/** `from`, `50%, 75.5%`, `@styleset`. */
const BLOCK_SELECTOR = /^@?[A-Za-z0-9%., -]+$/;

/**
 * True when a definition can be written into the sheet. The prelude is built from
 * these fields, so a name that fails here cannot leave the rule, and it cannot
 * replace a name the editor uses either, which is worth a constant check on a
 * sheet the canvas will share. No value may hold an external address either, read
 * by the parser's own scanner. The parser decides the rest.
 */
function isWritableDefinition(rule: ParsedDefinitionRule): boolean {
  const { atRule, name, style, blocks } = rule;
  if (!DEFINITION_AT_RULES.has(atRule)) return false;
  if (atRule === 'font-face') {
    if (name !== undefined || typeof style?.fontFamily !== 'string' || !FONT_FACE_FAMILY.test(style.fontFamily.trim())) return false;
  } else if (typeof name !== 'string' || !DEFINITION_NAME.test(name)) {
    return false;
  }
  const stayOnSite = (body: Record<string, unknown>): boolean => !Object.values(body).some(hasExternalAddress);
  if (blocks === undefined) return isStyleMap(style) && stayOnSite(style);
  return (
    style === undefined &&
    Array.isArray(blocks) &&
    blocks.length <= MAX_DEFINITION_BLOCKS &&
    blocks.every((block) => typeof block?.selector === 'string' && BLOCK_SELECTOR.test(block.selector) && isStyleMap(block.style) && stayOnSite(block.style))
  );
}

const bodyLength = (body: unknown): number =>
  isStyleMap(body) ? Object.entries(body).reduce((sum, [key, value]) => sum + key.length + (typeof value === 'string' ? value.length : 0), 0) : 0;

/** A lower bound on a definition's bytes, in characters, so a definition too big to fit costs no text to find out. */
function definitionLength({ style, blocks }: ParsedDefinitionRule): number {
  return bodyLength(style) + (Array.isArray(blocks) ? blocks.reduce((sum, block) => sum + bodyLength(block?.style), 0) : 0);
}

/**
 * One definition as sheet text, or the reason it stays out. Every declaration goes
 * through `declaration()`, but for the constant above. The parser and the sheet
 * check values apart, so one refusal drops the whole definition.
 */
function definitionText(rule: ParsedDefinitionRule): { text: string } | { refused: string } {
  const { atRule, name, style, blocks } = rule;
  let refused: string | undefined;
  const descriptors = (body: Record<string, unknown>): string => {
    const out: string[] = [];
    for (const [key, stored] of Object.entries(body)) {
      if (atRule === 'property' && key === 'syntax') {
        const syntax = propertySyntaxText(stored);
        if (syntax) out.push(`syntax:${syntax}`);
        else refused ??= key;
        continue;
      }
      if (isStyleMap(stored)) {
        refused ??= key;
        continue;
      }
      const value = typeof stored === 'number' && !PROPERTY_BODIES.has(atRule) && Number.isFinite(stored) ? String(stored) : stored;
      const decl = declaration(`@${atRule}`, key, value, (d) => {
        refused ??= d.property;
      });
      if (decl) out.push(decl);
    }
    return out.join(';');
  };
  const prelude = name ? `@${atRule} ${name}` : `@${atRule}`;
  const text = blocks
    ? `${prelude}{\n${blocks.map((block) => `${block.selector}{${descriptors(block.style)}}`).join('\n')}\n}`
    : `${prelude}{${descriptors(style ?? {})}}`;
  return refused === undefined ? { text } : { refused: `the stylesheet refuses its ${refused}` };
}

/** What a section of the sheet used of the two page caps. */
interface RuleBudget {
  rules: number;
  bytes: number;
}

/**
 * The definitions section of the sheet, and what it used of the page caps. Past a
 * cap, this definition and all later ones are dropped, for the reason given at
 * authoredBlocks. Rules then get what is left: a dropped `data:` font spends
 * nothing, so it costs the page that font and not its hover states.
 */
function definitionTexts(
  definitions: readonly DefinitionInput[],
  onDropRule: (dropped: DroppedRule) => void,
): { texts: string[]; spent: RuleBudget } {
  const texts: string[] = [];
  const spent: RuleBudget = { rules: 0, bytes: 0 };
  let full = false;
  for (const { node, rule } of definitions) {
    const drop = (reason: string) => onDropRule({ className: node, ruleId: rule.id, reason });
    if (full || spent.bytes + definitionLength(rule) > MAX_RULE_BYTES_PER_PAGE) {
      full = true;
      drop('the page is over its rule limit');
      continue;
    }
    if (!isWritableDefinition(rule)) {
      drop('its name, a block, a descriptor or an address could leave the rule or the site');
      continue;
    }
    const built = definitionText(rule);
    if ('refused' in built) {
      drop(built.refused);
      continue;
    }
    const size = textBytes(built.text);
    if (spent.rules + 1 > MAX_RULES_PER_PAGE || spent.bytes + size > MAX_RULE_BYTES_PER_PAGE) {
      full = true;
      drop('the page is over its rule limit');
      continue;
    }
    texts.push(built.text);
    spent.rules += 1;
    spent.bytes += size;
  }
  return { texts, spent };
}

/**
 * The authored section of the sheet, grouped by rule. In today's grouping by
 * breakpoint, a Tablet Hover would land after a Desktop Pressed and, having equal
 * specificity, beat it while pressing. Past a page cap, this rule and all later
 * ones are dropped, so a rule is never cut in half and the result never depends on
 * which later rule happens to be small enough to fit.
 */
function authoredBlocks(
  authored: readonly AuthoredRulesInput[],
  ordered: readonly BreakpointRef[],
  onDropRule: (dropped: DroppedRule) => void,
  spent: RuleBudget,
): RuleBlock[] {
  const out: RuleBlock[] = [];
  let bytes = spent.bytes;
  let full = false;
  for (const { className, rules } of authored) {
    if (!SAFE_RULE_CLASS.test(className)) continue;
    for (const rule of rules) {
      const drop = (reason: string) => onDropRule({ className, ruleId: rule.id, reason });
      if (full) {
        drop('the page is over its rule limit');
        continue;
      }
      if (!isWritableRule(rule)) {
        drop('its selector or a wrapper could leave the rule');
        continue;
      }
      const built = blocksOfRule(className, rule, ordered);
      if ('refused' in built) {
        drop(built.refused);
        continue;
      }
      const size = built.blocks.reduce((sum, block) => sum + textBytes(block.text) + textBytes(block.wrappers.join('')), 0);
      if (spent.rules + out.length + built.blocks.length > MAX_RULES_PER_PAGE || bytes + size > MAX_RULE_BYTES_PER_PAGE) {
        full = true;
        drop('the page is over its rule limit');
        continue;
      }
      out.push(...built.blocks);
      bytes += size;
    }
  }
  return out;
}

/**
 * The sheet, or nothing when it holds a `<`. sheetValueText and isWritableRule
 * each promise that it cannot, and `dangerouslySetInnerHTML` writes it raw, so a
 * future path that breaks the promise loses its styles rather than opening the
 * <style> element. The page still serves.
 */
export function withoutMarkup(sheet: string, onDropRule: (dropped: DroppedRule) => void): string {
  if (!sheet.includes('<')) return sheet;
  onDropRule({ className: 'sheet', ruleId: 'sheet', reason: 'the finished stylesheet held a <' });
  return '';
}

/**
 * Build the stylesheet text for a page. Rules keep the input order (the
 * caller walks the tree in a fixed order) and each rule keeps its properties
 * in stored order, so shorthands and longhands override each other the way
 * they do in the editor's inline style. The selector repeats the class
 * (`.fc-a.fc-a`) so a rule outranks any single utility class on the node
 * regardless of where the sheet lands relative to other stylesheets.
 *
 * Breakpoints with equal min widths are ordered by id; the later one's query
 * then matches below the earlier one's min width only, which is the closest
 * meaningful reading of a degenerate setup.
 */
export function buildResponsiveCss(
  rules: readonly ResponsiveRuleInput[],
  breakpoints: readonly BreakpointRef[],
  options: BuildResponsiveCssOptions = {},
): string {
  const onDrop = options.onDrop ?? (() => {});
  const ordered = largestFirst(
    [...breakpoints].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
  const safeRules = rules.filter(r => SAFE_CLASS.test(r.className));

  const block = (index: number): string =>
    safeRules
      .map(rule => {
        const decls = declarationsAt(rule, ordered, index, onDrop);
        return decls.length > 0 ? `.${rule.className}.${rule.className}{${decls.join(';')}}` : '';
      })
      .filter(Boolean)
      .join('\n');

  const onDropRule = options.onDropRule ?? (() => {});
  const { texts: definitions, spent } = definitionTexts(options.definitions ?? [], onDropRule);
  const parts: string[] = [...definitions];
  const base = block(0);
  if (base) parts.push(base);
  for (let i = 1; i < ordered.length; i++) {
    const body = block(i);
    if (!body) continue;
    parts.push(`${mediaBelow(ordered[i - 1].minWidth)}{\n${body}\n}`);
  }
  const authored = serializeBlocks(authoredBlocks(options.authored ?? [], ordered, onDropRule, spent));
  if (authored) parts.push(authored);
  if (options.fieldGuard) parts.push(FIELD_SIZING_GUARD);
  return withoutMarkup(parts.join('\n'), onDropRule);
}
