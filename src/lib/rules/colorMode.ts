// src/lib/rules/colorMode.ts
//
// A site whose theme forces a colour mode answers `prefers-color-scheme` itself
// (contract docs/plans/2026-11-02-theme-and-head.md, "Light and dark", slice T2).
// A site set to `light` with a node rule under `@media (prefers-color-scheme: dark)`
// would otherwise show that rule on a dark system while its tokens stay light: a
// half dark page. So the published sheet rewrites such a query before it is written:
// an operand the mode answers yes to is removed, one it answers no to drops its query.
//
// It rewrites only the forms it recognises and leaves every other prelude exactly as
// stored, invalid ones included. That matters: `not (prefers-color-scheme: dark) and
// (min-width: 600px)` is not valid media query syntax, so a browser reads it as `not
// all`, which never matches. Read literally, a rewrite would make that dead query live.
//
// The recognised forms, per query of a comma list:
//   - operands joined by `and`, each `(feature: value)` or `(not (feature: value))`;
//   - a whole query `not (prefers-color-scheme: x)`.
// `x` is `light` or `dark`. The boolean `(prefers-color-scheme)` matches in both modes,
// so it is left as stored, which is already right. A query holding the feature that is
// not in a recognised form (`or`, a media type, `and` without white space on both sides,
// a blank list member) is left as stored and reported, because no one operand answers
// it, and so is the whole list around it, unless another member makes the list true.
// test/renderGate/colorMode.gate.ts holds every answer to what Chromium and WebKit match.
//
// PURE: no React, no MST. Read by the published emitter (responsiveCss.ts) and, from
// slice T3, by the editor surfaces.

import type { ColorScheme } from '@/lib/site/theme';

/** What a prelude comes to under a forced mode. */
export interface ColorModePrelude {
  /** The prelude to write; '' when the mode alone makes it true; null when no query is left, so the rule is dropped. */
  prelude: string | null;
  /** Set when a query holds the feature in a form this cannot answer, and stays as stored. */
  warning?: string;
}

const FEATURE = /^\(\s*([A-Za-z-]+)\s*:\s*([A-Za-z0-9.-]+)\s*\)$/;
const NEGATED = /^\(\s*not\s+(\([^()]*\))\s*\)$/i;
const COLOR_FEATURE = 'prefers-color-scheme';

/**
 * The top-level items of a query: bracketed groups and words, in order. Null when the
 * brackets do not balance, or when two items touch with no white space between them:
 * CSS reads `and(` as a function and `)and` as one token, so a browser drops the whole
 * query (it reads `not all`), and taking the items apart would make it live.
 */
function items(query: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    // A top-level item that starts right where the previous one ended.
    const touches = depth === 0 && i > 0 && start === -1 && !/[ \t\n\r\f(]/.test(char) && query[i - 1] === ')';
    if (touches) return null;
    if (char === '(') {
      if (depth === 0) {
        // A word running into a bracket, or a bracket right after a bracket.
        if (start !== -1 || (i > 0 && query[i - 1] === ')')) return null;
        start = i;
      }
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) {
        out.push(query.slice(start, i + 1));
        start = -1;
      }
    } else if (depth === 0 && /[ \t\n\r\f]/.test(char)) {
      if (start !== -1) out.push(query.slice(start, i));
      start = -1;
    } else if (depth === 0 && start === -1) {
      start = i;
    }
  }
  if (depth !== 0) return null;
  if (start !== -1) out.push(query.slice(start));
  return out;
}

/** The queries of a list, split on top-level commas. Null when the brackets do not balance. */
function queries(prelude: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    if (prelude[i] === '(') depth++;
    else if (prelude[i] === ')') depth--;
    else if (prelude[i] === ',' && depth === 0) {
      out.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) return null;
  }
  if (depth !== 0) return null;
  out.push(prelude.slice(start).trim());
  return out;
}

/** An operand's answer under the mode: true, false, or null when it is not a colour scheme operand this reads. */
function operandAnswer(operand: string, mode: ColorScheme): boolean | null {
  const negated = NEGATED.exec(operand);
  const inner = negated ? negated[1] : operand;
  const feature = FEATURE.exec(inner);
  if (!feature || feature[1].toLowerCase() !== COLOR_FEATURE) return null;
  const value = feature[2].toLowerCase();
  if (value !== 'light' && value !== 'dark') return null;
  return (value === mode) !== (negated !== null);
}

const BOOLEAN = /^\(\s*[A-Za-z-]+\s*\)$/;

/** True when an operand is a recognised shape, whatever its feature: `(f: v)`, `(not (f: v))` or the boolean `(f)`. */
const isRecognisedOperand = (operand: string): boolean => BOOLEAN.test(operand) || FEATURE.test(NEGATED.exec(operand)?.[1] ?? operand);

const mentionsColorScheme = (text: string): boolean => text.toLowerCase().includes(COLOR_FEATURE);

type QueryAnswer = { kind: 'keep'; text: string } | { kind: 'true' } | { kind: 'false' } | { kind: 'unread'; text: string };

function answerQuery(query: string, mode: ColorScheme): QueryAnswer {
  if (!mentionsColorScheme(query)) return { kind: 'keep', text: query };
  const read = items(query);
  if (!read || read.length === 0) return { kind: 'unread', text: query };
  // A whole query `not (prefers-color-scheme: x)`.
  if (read[0].toLowerCase() === 'not') {
    if (read.length !== 2) return { kind: 'unread', text: query };
    const answer = operandAnswer(read[1], mode);
    if (answer === null) return { kind: 'unread', text: query };
    return answer ? { kind: 'false' } : { kind: 'true' };
  }
  // Operands joined by `and`.
  if (read.length % 2 === 0) return { kind: 'unread', text: query };
  const operands: string[] = [];
  for (let i = 0; i < read.length; i++) {
    if (i % 2 === 1) {
      if (read[i].toLowerCase() !== 'and') return { kind: 'unread', text: query };
      continue;
    }
    if (!isRecognisedOperand(read[i])) return { kind: 'unread', text: query };
    operands.push(read[i]);
  }
  const kept: string[] = [];
  let answered = false;
  for (const operand of operands) {
    const answer = operandAnswer(operand, mode);
    if (answer === null) {
      kept.push(operand);
      continue;
    }
    answered = true;
    if (!answer) return { kind: 'false' };
  }
  // The boolean `(prefers-color-scheme)` matches in both modes, and a value other than
  // light or dark is the browser's to read: both are left exactly as stored.
  if (!answered) return { kind: 'keep', text: query };
  return kept.length === 0 ? { kind: 'true' } : { kind: 'keep', text: kept.join(' and ') };
}

/**
 * An `@media` prelude under a forced mode. Unchanged when it holds no colour scheme
 * query, or only ones in a form this does not recognise.
 */
export function withColorMode(prelude: string, mode: ColorScheme): ColorModePrelude {
  if (!mentionsColorScheme(prelude)) return { prelude };
  const list = queries(prelude);
  if (!list) return { prelude, warning: `@media ${prelude} does not balance, so the site's colour mode cannot answer it` };
  // A browser reads a blank member as `not all`, but here it would come back as a query
  // with nothing left to answer, which means always true, and a dark rule would apply to
  // every visitor of a light site. Leave the list as stored.
  if (list.some((query) => query === '')) {
    return { prelude, warning: `@media ${prelude} has an empty query in its list, so the site's colour mode cannot answer it` };
  }
  const kept: string[] = [];
  let changed = false;
  let unread: string | undefined;
  for (const query of list) {
    const answer = answerQuery(query, mode);
    if (answer.kind === 'true') return { prelude: '', ...(unread ? { warning: unreadWarning(unread) } : {}) };
    if (answer.kind === 'false') {
      changed = true;
      continue;
    }
    if (answer.kind === 'unread') unread ??= answer.text;
    if (answer.text !== query) changed = true;
    kept.push(answer.text);
  }
  // A list with a member this cannot answer is left whole as stored: answering the rest
  // would mix the site's mode with the visitor's setting in one list. Only a member the
  // mode makes true decides it, above, since then the whole list is true.
  if (unread) return { prelude, warning: unreadWarning(unread) };
  if (!changed) return { prelude };
  return { prelude: kept.length > 0 ? kept.join(', ') : null };
}

const unreadWarning = (query: string): string =>
  `the query "${query}" reads prefers-color-scheme in a form the site's colour mode cannot answer, so it is left as stored`;

const MEDIA = /^@media(?=[\s(])/i;

/**
 * A rule's wrappers, outermost first, under a forced mode: an `@media` wrapper the mode
 * makes true is removed, and null means one of them can never match, so the rule is
 * dropped. Every other wrapper is left as stored.
 */
export function wrappersInColorMode(
  at: readonly string[],
  mode: ColorScheme,
  onWarning: (warning: string) => void = () => {},
): string[] | null {
  const out: string[] = [];
  for (const wrapper of at) {
    if (!MEDIA.test(wrapper)) {
      out.push(wrapper);
      continue;
    }
    const prelude = wrapper.slice('@media'.length).trim();
    const read = withColorMode(prelude, mode);
    if (read.warning) onWarning(read.warning);
    if (read.prelude === null) return null;
    if (read.prelude === '') continue;
    out.push(read.prelude === prelude ? wrapper : `@media ${read.prelude}`);
  }
  return out;
}
