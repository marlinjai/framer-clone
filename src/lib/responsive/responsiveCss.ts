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
// PURE: no React, no MST. Values are serialized the way React serializes an
// inline style (camelCase to kebab-case, px on non-zero numbers except the
// unitless properties), so moving a value from `style` into the sheet never
// changes what it means. A value or property name that could break out of its
// declaration (and so out of the rule or the <style> element) is dropped and
// logged once per page. A `;` is not such a value by itself: inside a quoted
// string or a url() it is data, as in `url("data:image/png;base64,...")`, and
// isContainedValue tells the two apart.

import { largestFirst, resolveCascade, type BreakpointRef } from './cascade';

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
const SAFE_PROPERTY = /^(?:[A-Za-z][A-Za-z0-9]*|--[A-Za-z0-9_-]+)$/;

/**
 * Characters that let a value escape its declaration wherever they appear,
 * quoted or not: `{` `}` open or close a rule, `<` can start `</style>` and end
 * the element (the sheet is written raw, so CSS quoting does not protect it), a
 * backslash starts a CSS escape that can hide any of these or a closing quote,
 * and control characters (newlines included) have no place in a value. Mirrors
 * STYLE_BREAKOUT_CHARS in src/lib/ai/pageGen/validate.ts, plus `<` and `>`, and
 * without `;`, which depends on where it stands: see isContainedValue.
 */
const BREAKOUT_CHARS = /[{}<>\\\u0000-\u001f\u007f]/;

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
 * True when the value stays inside its declaration, read the way the browser
 * tokenizes it. Call only on text free of BREAKOUT_CHARS: with no backslash a
 * quote cannot be escaped, and with no newline a string cannot end early, so a
 * quote always closes at its next match. A `;` counts as data only inside a
 * string or an unquoted url(). Anywhere else it ends the declaration, so the
 * value is refused. A string, block or url() left open is refused too, because
 * the browser would carry on through the `;` and `}` that follow it and swallow
 * the rest of the rule.
 */
function isContainedValue(text: string): boolean {
  const closers: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return false;
      i = close + 1;
    } else if (ch === '(') {
      let body = i + 1;
      while (text[body] === ' ') body++;
      const quoted = text[body] === '"' || text[body] === "'";
      const kind = quoted ? 'block' : parenKind(text, i);
      if (kind === 'ambiguous') return false;
      if (kind === 'url') {
        i = endOfUnquotedUrl(text, body);
        if (i === -1) return false;
      } else {
        closers.push(')');
        i++;
      }
    } else if (ch === '[') {
      closers.push(']');
      i++;
    } else if (ch === ')' || ch === ']') {
      if (closers.pop() !== ch) return false;
      i++;
    } else if (ch === ';') {
      return false;
    } else {
      i++;
    }
  }
  return closers.length === 0;
}

/**
 * Script-capable or import-capable CSS. Mirrors UNSAFE_STYLE_VALUE in
 * src/lib/ai/pageGen/validate.ts (copied, not imported: that module pulls in
 * the MST models, which this pure, client-safe module must not).
 */
const UNSAFE_VALUE = /javascript:|vbscript:|expression\s*\(|<\s*\/?\s*script|@import|behavior\s*:|-moz-binding|\/\*/i;

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
  return BREAKOUT_CHARS.test(text) || UNSAFE_VALUE.test(text) || !isContainedValue(text) ? 'unsafe-value' : null;
}

/** Why a declaration was dropped; reported once per page through `onUnsafe`. */
export interface DroppedDeclaration {
  className: string;
  property: string;
  reason: 'unsafe-property' | 'unsafe-value';
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
  return text === undefined ? null : `${cssPropertyName(key)}:${text}`;
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

export interface BuildResponsiveCssOptions {
  /** Called for every declaration dropped as unsafe. */
  onDrop?: (dropped: DroppedDeclaration) => void;
}

/** True when a style value is a responsive map rather than a scalar. */
export function isStyleMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const SAFE_CLASS = /^fc-[A-Za-z0-9_-]+$/;

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
    parts.push(`@media (max-width:${maxWidthBelow(ordered[i - 1].minWidth)}px){\n${body}\n}`);
  }
  return parts.join('\n');
}
