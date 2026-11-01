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
// `url("data:image/png;base64,...")`, and isContainedValue tells the two apart.
//
// Rules arrive here parsed: the type says so, and the one place that reads stored
// rules for the page is applyResponsiveStyles. A rule is emitted whole or not at
// all.

import type { ParsedSelectorRule } from '@/lib/rules/rules';
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
 * quoted or not: `{` `}` open or close a rule, a backslash starts a CSS escape
 * that can hide any of these or a closing quote, and control characters have no
 * place in a value. `;` is not here, because it depends on where it stands (see
 * isContainedValue), and neither is what sheetValueText handles by position: a
 * tab or a newline, `<` and `>`.
 */
const BREAKOUT_CHARS = /[{}\\\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

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
  /** Every address: each url(), quoted or not, and each string inside image-set(). */
  urls: string[];
  /** Every string, without its quotes. */
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
 * Read a value token by token. Call only on text with no backslash of its own and
 * no raw newline in a string, so a quote always closes at its next match: the AI
 * validator's breakout check gives that, and so does sheetValueText, whose own
 * escapes hold no quote. Everything that asks where a value points goes through
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
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return scan;
      const body = text.slice(i + 1, close);
      const inside = open[open.length - 1]?.name ?? '';
      scan.strings.push(body);
      if (inside === 'url' || isImageSet(inside)) scan.urls.push(body.trim());
      i = close + 1;
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
 * The text the sheet holds for a value, or null when it cannot hold it. Where the
 * emitter owns the output it widens what a value may be: inside a string `<` is
 * written `\3c ` and a newline `\a `, and a tab or newline between tokens becomes a
 * space. So the output never holds a `<`, which matters because the sheet is
 * written raw and CSS quoting does not protect the <style> element. Everything is
 * then checked as written, by isContainedValue. Stored text with no tab, newline
 * or `<` comes back unchanged.
 */
function sheetValueText(text: string): string | null {
  if (BREAKOUT_CHARS.test(text) || UNSAFE_VALUE.test(text)) return null;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return null;
      out += ch + text.slice(i + 1, close).replace(/\r\n|[\n\r\f]/g, '\\a ').replace(/</g, '\\3c ') + ch;
      i = close + 1;
    } else if (ch === '<' || ch === '>') {
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

export interface BuildResponsiveCssOptions {
  /** Called for every declaration dropped as unsafe. */
  onDrop?: (dropped: DroppedDeclaration) => void;
  /** Authored rules, in walk order. They follow every Normal block. */
  authored?: readonly AuthoredRulesInput[];
  /** Called for every authored rule left out of the sheet. */
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
): RuleBlock[] {
  const out: RuleBlock[] = [];
  let bytes = 0;
  let full = false;
  for (const { className, rules } of authored) {
    if (!SAFE_RULE_CLASS.test(className)) continue;
    for (const rule of rules) {
      const drop = (reason: string) => onDropRule({ className, ruleId: rule.id, reason });
      if (full) {
        drop('the page is over its rule limit');
        continue;
      }
      const built = blocksOfRule(className, rule, ordered);
      if ('refused' in built) {
        drop(built.refused);
        continue;
      }
      const size = built.blocks.reduce((sum, block) => sum + textBytes(block.text) + textBytes(block.wrappers.join('')), 0);
      if (out.length + built.blocks.length > MAX_RULES_PER_PAGE || bytes + size > MAX_RULE_BYTES_PER_PAGE) {
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

  const parts: string[] = [];
  const base = block(0);
  if (base) parts.push(base);
  for (let i = 1; i < ordered.length; i++) {
    const body = block(i);
    if (!body) continue;
    parts.push(`${mediaBelow(ordered[i - 1].minWidth)}{\n${body}\n}`);
  }
  const authored = serializeBlocks(authoredBlocks(options.authored ?? [], ordered, options.onDropRule ?? (() => {})));
  if (authored) parts.push(authored);
  return parts.join('\n');
}
