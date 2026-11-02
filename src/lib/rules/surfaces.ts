// src/lib/rules/surfaces.ts
//
// What the two editor surfaces change about a stored rule. Both share a document
// with the editor, and their frames are not viewports, so buildResponsiveCss cannot
// write a rule there the way it does on the published page. See "The canvas" and
// "The preview surface" in docs/plans/2026-11-02-selector-styling.md.
//
//   - The canvas never reacts to the real pointer or the editor's environment. The
//     five pointer pseudo-classes are written dead, or live for a previewed rule,
//     and a condition on the window is evaluated against the frame.
//   - Neither surface lets a stored rule read the editor. A rule shares a document
//     with the signed-in editor, and `&:is(html:has([data-x*="a"]) *)` reads what it
//     holds, with a Normal background to report it to a third party. So a condition
//     that can look beyond the node is a constant here, whatever the document holds.
//     The published page keeps it, where the document is the stored page itself.
//   - Every rule declaration gets `!important`, which beats the inline Normal the
//     way a rule beats Normal on the published page. That also beats what the editor
//     writes inline, so editor-owned properties are never emitted on the canvas.
//   - Animations stay at rest on the canvas, at their end state.
//   - The preview keeps real pseudo-classes and real conditions, but for a condition
//     on the width or height, which the window cannot answer for a frame.
//
// PURE and client-safe. responsiveCss.ts imports this as a value, and rules.ts
// imports responsiveCss.ts, so nothing here may import either as a value.

export type EditorSurfaceKind = 'canvas' | 'preview';

/** The box a condition on the window is answered from. */
export interface SurfaceFrame {
  width: number;
  height: number;
}

/**
 * What ComponentRenderer writes inline so a node can be selected, a locked node
 * cannot be, and inline text editing works. `!important` beats inline and an
 * animation beats it with no `!important` at all, so none of these reaches the
 * canvas, in a rule or in a keyframe. `all` and `interactivity` are not in the
 * contract's list and are the same thing: `all` resets every one of these, and
 * `interactivity:inert` takes a node out of hit testing with `pointer-events`
 * untouched. `-webkit-user-modify` turns a contentEditable box read only.
 */
const EDITOR_OWNED: ReadonlySet<string> = new Set([
  'pointer-events',
  'user-select',
  '-webkit-user-select',
  '-webkit-touch-callout',
  'cursor',
  'all',
  'interactivity',
  '-webkit-user-modify',
]);

/** True for a property the canvas never emits. Takes the name as CSS writes it. */
export const isEditorOwned = (property: string): boolean => EDITOR_OWNED.has(property.toLowerCase());

/**
 * One declaration with `!important`. A stored one is removed first, or the doubled
 * text would be invalid and the rule would vanish on the editor surfaces only. A
 * string ends in a quote, so `content:"!important"` is left alone.
 */
export function asImportant(declaration: string): string {
  // Spaces in front are trimmed apart: a pattern starting with them retries from each one.
  const without = declaration.replace(/!\s*important\s*$/i, '');
  return `${without === declaration ? declaration : without.trimEnd()}!important`;
}

// --- constant conditions --------------------------------------------------

const POINTER_STATES: ReadonlySet<string> = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within']);

/** Matches, with the specificity of the pseudo-class it stands for. `:is(*)` would lose a tie the published page wins. */
export const LIVE_STATE = ':is(*, :hover)';
/** Never matches, with the same specificity. */
export const DEAD_STATE = ':not(*, :hover)';

const isNameCharacter = (ch: string | undefined): boolean => ch !== undefined && (/[A-Za-z0-9_-]/.test(ch) || ch >= '\u0080');

/** The index just past the quoted string opening at `start`. One left open, which only hand-built text can hold, ends the text. */
function pastString(text: string, start: number): number {
  const close = text.indexOf(text[start], start + 1);
  return close === -1 ? text.length : close + 1;
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = pastString(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** True when a selector list holds a complex selector: a combinator at its top level. */
function holdsCombinator(list: string): boolean {
  let depth = 0;
  let i = 0;
  let spaced = false;
  let started = false;
  while (i < list.length) {
    const ch = list[i];
    if (ch === '"' || ch === "'") {
      i = pastString(list, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0) {
      if (ch === ',') {
        spaced = false;
        started = false;
      } else if (/\s/.test(ch)) {
        spaced = started;
      } else {
        if (ch === '>' || ch === '+' || ch === '~' || list.startsWith('||', i)) return true;
        if (spaced) return true;
        started = true;
      }
    } else if (spaced) {
      return true;
    } else {
      started = true;
    }
    i++;
  }
  return false;
}

/**
 * True when this functional pseudo-class can look beyond the node. Deny by default,
 * so a form that arrives later cannot slip through: any of them holding a complex
 * selector counts, because `html x` or `* x` matches on what is above the node. That
 * also catches one nested deeper, since the walk goes on inside what does not count.
 * `:has()` does not: its arguments are relative to the node, and a sibling step from
 * a page's root finds nothing on either surface. A compound argument only tests the
 * subject itself or, in `:nth-child(n of x)`, its siblings: the stored page either way.
 */
function looksOutward(name: string, inner: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'has') return false;
  if (!lower.startsWith('nth-')) return holdsCombinator(inner);
  const of = /\bof\b/i.exec(inner);
  return of !== null && holdsCombinator(inner.slice(of.index + of[0].length));
}

/**
 * The text with what an editor surface must not read written as a constant, `live`
 * for a previewed rule. Each form keeps the specificity of what it stands for, so a
 * tie comes out as it does on the published page. Dead and live both have one result
 * whatever their argument matches, so nothing in the editor can change the outcome.
 *
 *   - An outward condition, any depth, on either surface: `:is(html x)` becomes
 *     `:not(*, :is(html x))`, and `:is(*, :is(html x))` when live. The preview has
 *     nothing to preview with, so there it is always dead.
 *   - A pointer state on the canvas only, wherever it stands and in any case. The
 *     preview has a real pointer.
 *
 * A string or an attribute selector is not read, and neither is a pseudo-element's
 * name or a longer name. The parser has read this text, so a quote closes at its next
 * match. One left open stops the read.
 */
export function constantConditions(text: string, kind: EditorSurfaceKind, live: boolean): string {
  let out = '';
  let brackets = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = pastString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    if (ch !== ':' || brackets > 0) {
      out += ch;
      i++;
      continue;
    }
    const isElement = text[i + 1] === ':';
    const start = isElement ? i + 2 : i + 1;
    let end = start;
    while (isNameCharacter(text[end])) end++;
    const name = text.slice(start, end);
    if (!isElement && text[end] === '(') {
      const close = closingParen(text, end);
      if (close !== -1 && looksOutward(name, text.slice(end + 1, close))) {
        out += `${live ? ':is' : ':not'}(*, ${text.slice(i, close + 1)})`;
        i = close + 1;
        continue;
      }
    }
    const isState = kind === 'canvas' && !isElement && text[end] !== '(' && POINTER_STATES.has(name.toLowerCase());
    out += isState ? (live ? LIVE_STATE : DEAD_STATE) : text.slice(i, end);
    i = end;
  }
  return out;
}

/** Every functional pseudo-class of `text` with its argument, in reading order, nested ones included. */
function functionalPseudoClasses(text: string): { name: string; inner: string }[] {
  const found: { name: string; inner: string }[] = [];
  forEachPseudo(text, (name, isElement, end) => {
    if (isElement || text[end] !== '(') return;
    const close = closingParen(text, end);
    if (close !== -1) found.push({ name: name.toLowerCase(), inner: text.slice(end + 1, close) });
  });
  return found;
}

/** Calls `visit` for each pseudo-class and pseudo-element. A string or an attribute selector is not read. */
function forEachPseudo(text: string, visit: (name: string, isElement: boolean, end: number) => void): void {
  let brackets = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = pastString(text, i);
      continue;
    }
    if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    if (ch !== ':' || brackets > 0) {
      i++;
      continue;
    }
    const isElement = text[i + 1] === ':';
    const start = isElement ? i + 2 : i + 1;
    let end = start;
    while (isNameCharacter(text[end])) end++;
    visit(text.slice(start, end), isElement, end);
    i = end;
  }
}

/** Every pseudo-class in the text at any depth, in lower case, without its argument. */
export function pseudoClassesIn(text: string): string[] {
  const names: string[] = [];
  forEachPseudo(text, (name, isElement) => {
    if (!isElement) names.push(name.toLowerCase());
  });
  return names;
}

/** The entries of a selector list, trimmed. */
function listEntries(list: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < list.length) {
    const ch = list[i];
    if (ch === '"' || ch === "'") {
      i = pastString(list, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      entries.push(list.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  entries.push(list.slice(start).trim());
  return entries;
}

/**
 * True when any condition in this selector can read past the node, at any depth. It
 * is stricter than `constantConditions`, which leaves `:has()` alone because a
 * sibling step from a page's root finds nothing there. A generated rule sits at any
 * depth of a stored page, so `&:has(~ * input:checked)` reads a sibling's subtree. The
 * walk is flat, because `functionalPseudoClasses` already reaches every depth.
 */
export function looksBeyondNode(selector: string): boolean {
  return functionalPseudoClasses(selector).some(({ name, inner }) =>
    name === 'has' ? listEntries(inner).some((entry) => /^(?:[~+]|\|\|)/.test(entry)) : looksOutward(name, inner),
  );
}

// --- conditions -----------------------------------------------------------

/**
 * What a media condition means on a frame. `environment` describes the editor's
 * window or system rather than the frame, and `unknown` is a condition on the frame
 * that cannot be worked out, such as `em` or `calc()`. Either shows only when
 * previewed. `unknown` is kept apart for the note on the rule's row in the panel.
 */
export type ConditionVerdict = 'yes' | 'no' | 'environment' | 'unknown';

const FRAME_FEATURES: ReadonlySet<string> = new Set(['width', 'height', 'aspect-ratio', 'orientation']);

const frameValue = (name: string, frame: SurfaceFrame): number =>
  name === 'width' ? frame.width : name === 'height' ? frame.height : frame.height > 0 ? frame.width / frame.height : 0;

/**
 * A constant as a number, or null. `rem` counts at 16px, the initial value a media
 * query reads whatever a page does to its root, because Tailwind's `lg:` compiles to
 * it. `em` means the same in a query, and the contract leaves it unevaluated.
 */
function constantOf(name: string, text: string): number | null {
  if (name === 'aspect-ratio') {
    const ratio = /^(\d+(?:\.\d+)?|\.\d+)\s*(?:\/\s*(\d+(?:\.\d+)?|\.\d+))?$/.exec(text);
    if (!ratio) return null;
    const divisor = ratio[2] === undefined ? 1 : Number(ratio[2]);
    return divisor === 0 ? null : Number(ratio[1]) / divisor;
  }
  if (text === '0') return 0;
  const length = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem)$/i.exec(text);
  if (!length) return null;
  return Number(length[1]) * (length[2].toLowerCase() === 'rem' ? 16 : 1);
}

function compared(left: number, operator: string, right: number): boolean {
  switch (operator) {
    case '>': return left > right;
    case '>=': return left >= right;
    case '<': return left < right;
    case '<=': return left <= right;
    default: return left === right;
  }
}

/** `(name: value)`, with or without `min-` or `max-`. */
function plainFeature(name: string, value: string, frame: SurfaceFrame): ConditionVerdict {
  const prefix = /^(min|max)-/.exec(name)?.[1];
  const feature = prefix ? name.slice(prefix.length + 1) : name;
  if (!FRAME_FEATURES.has(feature)) return 'environment';
  if (feature === 'orientation') {
    if (prefix || (value !== 'portrait' && value !== 'landscape')) return 'unknown';
    return (frame.height >= frame.width ? 'portrait' : 'landscape') === value ? 'yes' : 'no';
  }
  const constant = constantOf(feature, value);
  if (constant === null) return 'unknown';
  const operator = prefix === 'min' ? '>=' : prefix === 'max' ? '<=' : '=';
  return compared(frameValue(feature, frame), operator, constant) ? 'yes' : 'no';
}

/** `(width >= 600px)` or `(600px > width >= 400px)`. The feature may stand on either side. */
function rangeFeature(pieces: string[], frame: SurfaceFrame): ConditionVerdict {
  const terms = pieces.filter((_, index) => index % 2 === 0).map((term) => term.trim().toLowerCase());
  const feature = terms.find((term) => FRAME_FEATURES.has(term));
  if (!feature) return terms.some((term) => /^[a-z-]+$/.test(term)) ? 'environment' : 'unknown';
  if (feature === 'orientation') return 'unknown';
  const read = (term: string): number | null => (term === feature ? frameValue(feature, frame) : constantOf(feature, term));
  for (let i = 1; i < pieces.length; i += 2) {
    const leftTerm = terms[(i - 1) / 2];
    const rightTerm = terms[(i + 1) / 2];
    const left = read(leftTerm);
    const right = read(rightTerm);
    if (left === null || right === null || (leftTerm !== feature && rightTerm !== feature)) return 'unknown';
    if (!compared(left, pieces[i], right)) return 'no';
  }
  return 'yes';
}

function featureVerdict(body: string, frame: SurfaceFrame): ConditionVerdict {
  const colon = body.indexOf(':');
  if (colon !== -1) return plainFeature(body.slice(0, colon).trim().toLowerCase(), body.slice(colon + 1).trim().toLowerCase(), frame);
  const pieces = body.split(/(>=|<=|=|>|<)/);
  if (pieces.length > 1) return rangeFeature(pieces, frame);
  return FRAME_FEATURES.has(body.trim().toLowerCase()) ? 'yes' : 'environment';
}

/** The words and bracketed groups at the top level of a query. Call on text that balances. */
function queryItems(query: string): string[] {
  const items: string[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) {
      i++;
    } else if (query[i] === '(') {
      let depth = 0;
      let end = i;
      do {
        if (query[end] === '(') depth++;
        else if (query[end] === ')') depth--;
        end++;
      } while (depth > 0 && end < query.length);
      items.push(query.slice(i, end));
      i = end;
    } else {
      let end = i;
      while (end < query.length && !/[\s(]/.test(query[end])) end++;
      items.push(query.slice(i, end));
      i = end;
    }
  }
  return items;
}

/** The query's operands and whether it is negated, or null for a shape this does not read, such as `or`. */
function queryOperands(query: string): { operands: string[]; negated: boolean } | null {
  const items = queryItems(query);
  const first = items[0]?.toLowerCase();
  const negated = first === 'not';
  const rest = negated || first === 'only' ? items.slice(1) : items;
  if (rest.length % 2 === 0) return null;
  const operands = rest.filter((_, index) => index % 2 === 0);
  return rest.every((item, index) => index % 2 === 0 || item.toLowerCase() === 'and') ? { operands, negated } : null;
}

function operandVerdict(operand: string, frame: SurfaceFrame): ConditionVerdict {
  if (!operand.startsWith('(')) {
    const type = operand.toLowerCase();
    return type === 'all' || type === 'screen' ? 'yes' : 'environment';
  }
  const inner = operand.slice(1, -1).trim();
  return inner.startsWith('(') || /^not\b/i.test(inner) ? queryVerdict(inner, frame) : featureVerdict(inner, frame);
}

function queryVerdict(query: string, frame: SurfaceFrame): ConditionVerdict {
  const read = queryOperands(query);
  if (!read) return 'unknown';
  const verdicts = read.operands.map((operand) => operandVerdict(operand, frame));
  const verdict = (['no', 'unknown', 'environment'] as const).find((level) => verdicts.includes(level)) ?? 'yes';
  if (!read.negated) return verdict;
  return verdict === 'yes' ? 'no' : verdict === 'no' ? 'yes' : verdict;
}

/** The queries of a list. Call on text that balances. */
function queryList(prelude: string): string[] {
  const queries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    if (prelude[i] === '(') depth++;
    else if (prelude[i] === ')') depth--;
    else if (prelude[i] === ',' && depth === 0) {
      queries.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  queries.push(prelude.slice(start));
  return queries.map((query) => query.trim());
}

/** What an `@media` prelude means on a frame. A list is true when any query is. */
export function mediaVerdict(prelude: string, frame: SurfaceFrame): ConditionVerdict {
  const verdicts = queryList(prelude).map((query) => queryVerdict(query, frame));
  return (['yes', 'unknown', 'environment'] as const).find((level) => verdicts.includes(level)) ?? 'no';
}

/** The query without the operands the frame already answers yes to, so what is left reads the real environment. */
function withoutFrameOperands(query: string, frame: SurfaceFrame): string {
  const read = queryOperands(query);
  if (!read || read.negated) return query;
  return read.operands.filter((operand) => operandVerdict(operand, frame) !== 'yes').join(' and ');
}

/**
 * An `@media` prelude on the preview: null when the frame rules it out, '' when the
 * frame alone makes it true, otherwise what the real environment still has to answer.
 */
function previewPrelude(prelude: string, frame: SurfaceFrame): string | null {
  const kept: string[] = [];
  for (const query of queryList(prelude)) {
    const verdict = queryVerdict(query, frame);
    if (verdict === 'yes') return '';
    if (verdict !== 'no') kept.push(withoutFrameOperands(query, frame));
  }
  return kept.length > 0 ? kept.join(', ') : null;
}

/**
 * A rule's wrappers as this surface writes them, or null when the block is omitted
 * on this frame. A `previewed` rule loses its environment wrappers. A constant
 * condition the frame refuses still omits it, so a preview shows each frame what
 * that frame would show.
 */
export function surfaceWrappers(
  at: readonly string[],
  frame: SurfaceFrame,
  kind: EditorSurfaceKind,
  previewed: boolean,
): string[] | null {
  const out: string[] = [];
  for (const wrapper of at) {
    const match = /^@([A-Za-z-]+)\s*([\s\S]*)$/.exec(wrapper);
    const name = match?.[1].toLowerCase();
    if (match && name === 'media') {
      if (kind === 'preview') {
        const prelude = previewPrelude(match[2], frame);
        if (prelude === null) return null;
        if (prelude) out.push(`@${match[1]} ${prelude}`);
        continue;
      }
      const verdict = mediaVerdict(match[2], frame);
      if (verdict === 'no' || (verdict !== 'yes' && !previewed)) return null;
      continue;
    }
    if (match && name === 'scope' && match[2].trim()) {
      // Its root is matched against what is above the node, compound or not, and
      // that is the editor here. Dead, and live with the prelude gone when previewed.
      if (previewed) continue;
      return null;
    }
    out.push(wrapper);
  }
  return out;
}

// --- animations -----------------------------------------------------------

/** The roots a canvas copy renders under. The preview overlay shares this document and renders the same ids. */
export const VIEWPORT_ROOT = '[data-viewport-content-id]';
export const FLOATING_ROOT = '[data-floating-root-id]';
/** The root of a preview copy. */
export const PREVIEW_ROOT = '[data-preview-frame]';

const AT_REST = 'animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important';

/**
 * Animations on the canvas, after the rules. That gives a `forwards` reveal its end
 * state and an infinite one its rest, where `animation:none` would leave a Normal
 * `opacity:0` invisible and `*` alone would miss pseudo-elements. The root repeats
 * so this ties a stored timing on `&`, which sits under one root and one id, and
 * wins by coming last. A timing with a higher specificity still runs, the contract's
 * accepted edge. A node being previewed, and what is inside it, is left out: that is
 * how a keyframe is played. Ids must be safe to write in an attribute selector.
 */
export function animationsAtRest(previewed: readonly string[]): string {
  const exempt = previewed.flatMap((id) => [`[data-inner-component-id="${id}"]`, `[data-inner-component-id="${id}"] *`]);
  const not = exempt.length > 0 ? `:not(${exempt.join(', ')})` : '';
  const selectors = [VIEWPORT_ROOT, FLOATING_ROOT].flatMap((root) =>
    ['', '::before', '::after'].map((pseudo) => `${root}${root} *${not}${pseudo}`),
  );
  return `${selectors.join(',')}{${AT_REST}}`;
}
