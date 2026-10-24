// src/lib/ai/pageGen/tells.ts
//
// The deterministic screen for "vibe-coded" tells in a generated page (plan
// docs/plans/2026-10-23-ai-design-quality-round-2.md, decision 2). It runs on
// the VALIDATED tree (GeneratedNodeSnapshot, ./validate.ts) before the route
// applies a generation:
//
//   autoFixTells(tree)  applies the mechanical, safe fixes and reports them;
//   detectTells(tree)   reports every tell it can see, each marked autoFixable
//                       or not. The route feeds the non-fixable ones into the
//                       existing repair round.
//
// Pure: no mutation of the input, no I/O. Client-safe, so the visual review
// pass and tests can reuse it.
//
// The rules, one per tell of the plan (numbers in brackets), with the
// thresholds chosen to avoid false positives on legitimate designs:
//
//   em-dash [4]        (fixed) Em and en dashes and a spaced "--" in visible
//                      copy (text, alt, page title and description). A dash
//                      between two digits (8:00 to 18:30, 2019 to 2024) or an
//                      unspaced en dash between two letters (Mo to Fr) is a
//                      range and becomes a plain hyphen, which reads right in
//                      every language (" to " would be wrong on a German
//                      page). A leading or trailing dash (an attribution) is
//                      dropped. Two dashes in one sentence are a paired aside
//                      and become commas. A single dash after a short lead of
//                      at most three words ("Open daily", "Neu") becomes a
//                      colon, otherwise a comma.
//   emoji [2]          (fixed) Emoji are removed from copy. Kept: (c), (r),
//                      trademark, and the rating stars U+2605 / U+2606 (not
//                      emoji). A keycap emoji keeps its digit. A text node
//                      that held ONLY emoji was an icon stand-in: it is
//                      removed and also reported as emoji-icon (not fixable),
//                      so the repair round can give the spot a real visual.
//   banned-font [5]    (fixed) Inter, Geist and Space Grotesk are removed from
//                      fontFamily stacks; when only generic families remain
//                      the key is dropped so the page's own stack inherits.
//                      The font library's normaliser in validate.ts owns
//                      font rewriting; this is a backstop that is a no-op on
//                      a tree that went through it. A banned family in the
//                      `font` shorthand is reported, not rewritten.
//   button-arrow [16]  (fixed) A trailing arrow glyph (->, =>, U+2192 and its
//                      relatives, U+203A, U+00BB, a bare >) on the text of a
//                      button or link (or text inside one) is removed. A label
//                      that is only an arrow is left alone.
//   feature-cards [6]  Three or more sibling cards with the same structure in
//                      one row: a flex row, or a grid with three or more
//                      tracks (repeat(3, ...), "1fr 1fr 1fr", auto-fit). A
//                      card is a box (background, border, shadow, or radius
//                      with padding, or the card preset) whose subtree holds a
//                      heading and a text, at most four direct children, and
//                      no link, button or list: pricing tiers and product
//                      cards (which carry a call to action or a feature list)
//                      are legitimate and exempt. A column (a price list) is
//                      not a row.
//   bento-grid [7, 8]  A grid of four or more tiles (boxes or images) where at
//                      least one tile spans two or more tracks (span 2, 1 / 3)
//                      or gridTemplateAreas gives an area more than one cell.
//                      A full-row span (1 / -1, used for a heading cell) does
//                      not count.
//   purple-on-black [12] A near-black background (lightness at most 12%) with
//                      a violet or purple accent (hue 240 to 300 degrees,
//                      saturation at least 40%, lightness 30 to 80%) in its
//                      own colours or its subtree's (text, fill, border,
//                      shadow, gradient stops). One finding per dark root. A
//                      container awaiting a background photo is exempt (the
//                      photo is the surface, not the dark fallback colour).
//   radial-orb [13]    A radial-gradient with a chromatic stop that is not a
//                      repeating pattern (a vignette scrim of black, white or
//                      grey stops is legitimate), or a filter blur of 16px or
//                      more on a coloured box without text (a blurred blob).
//   dot-grid [14]      A gradient background repeated as a small tile
//                      (backgroundSize at most 80px): radial dots or linear
//                      grid lines.
//   rainbow [18]       A gradient with three or more distinct chromatic hues
//                      spanning at least 90 degrees (achromatic stops such as
//                      a scrim do not count), or three or more sibling boxes
//                      each filled with a different saturated hue spanning at
//                      least 120 degrees (a rainbow card set).
//   gradient-text [18] backgroundClip "text" over a gradient.
//   glass [3]          backdropFilter blur. A sticky or fixed navigation bar
//                      (header or nav, or position sticky / fixed) is exempt:
//                      a frosted nav keeps text readable while content
//                      scrolls under it, that is function, not decoration.
//   terminal [9]       A dark box (lightness at most 20%) with monospace text
//                      and either a prompt line ($, >, U+276F, % at a line
//                      start) or three small round dots (window controls).
//   not-x-its-y [10]   Copy like "It's not X, it's Y", "isn't just",
//                      "more than just", "Not a X. A Y.", "not just X but Y",
//                      and the German "ist nicht X, es ist Y", "mehr als
//                      nur", "kein X, sondern Y". "Not only ... but also" and
//                      "nicht nur ... sondern auch" are ordinary grammar and
//                      not matched; neither is "more than 20 years".
//   sparkle [15]       Sparkle glyphs (U+2726, U+2727, U+2728, U+2733,
//                      U+2734, U+2747, U+2736 to U+273A) in copy, or a layer
//                      named sparkle. Rating stars are not sparkles.
//   hover-everywhere [17] At least three card-like boxes carry a transition
//                      and they are at least 60% of all card-like boxes.
//                      (The editor has no hover state, so a transition on a
//                      card only ever exists as a hover effect someone meant.)
//   icon-set [1]       Lucide and friends cannot be expressed: svg is a
//                      forbidden tag and there is no icon preset. The only way
//                      in is an img whose src points at an icon set (lucide,
//                      heroicons, feather, tabler, phosphor), which is flagged.
//   placeholder-demo [11] A box standing in for a product shot: a gradient
//                      background with no text and no image in it, sized like
//                      media (aspectRatio, or a px height / minHeight of 120
//                      or more); or a fake screen, four or more nested boxes
//                      with no text and no image at all. Containers awaiting a
//                      photo are exempt (their scrim gradient is not a demo).

import type { GeneratedNodeSnapshot } from './validate';

// ---------------------------------------------------------------- types

export type TellId =
  | 'em-dash'
  | 'emoji'
  | 'emoji-icon'
  | 'banned-font'
  | 'button-arrow'
  | 'feature-cards'
  | 'bento-grid'
  | 'purple-on-black'
  | 'radial-orb'
  | 'dot-grid'
  | 'rainbow'
  | 'gradient-text'
  | 'glass'
  | 'terminal'
  | 'not-x-its-y'
  | 'sparkle'
  | 'hover-everywhere'
  | 'icon-set'
  | 'placeholder-demo'
  // Page essentials (./essentials.ts): not design tells, but they share the
  // finding shape and the single repair round.
  | 'hero-cta'
  | 'alt-text';

export interface TellFinding {
  tell: TellId;
  /** Where: the layer-label path ("Features > Card (2)"), or "page title" / "page description". */
  path: string;
  /** What was found and what to do instead, written for the model's repair round and the user. */
  detail: string;
  /** Whether autoFixTells fixes it. */
  autoFixable: boolean;
}

/** One kind of automatic fix, aggregated over the tree (so seven buttons are one line, not seven). */
export interface TellFix {
  tell: TellId;
  count: number;
  /** A sentence for the dialog's list of automatic fixes. */
  detail: string;
}

/** The node shape the screen reads: a validated snapshot. */
export type TellNode = Pick<GeneratedNodeSnapshot, 'id' | 'type' | 'label' | 'props'> & { children: TellNode[] };

export interface TellTree<N extends TellNode = TellNode> {
  title?: string;
  description?: string;
  nodes: N[];
}

export interface TellOptions {
  /**
   * Nodes that will receive a stock photo (the validated result's
   * imageRequests): a container's scrim-only background or an img's
   * placeholder src is not what the visitor will see.
   */
  photoNodeIds?: ReadonlySet<string>;
  /** Breakpoint keys, largest first; the first one is the desktop value of a responsive map. */
  breakpointKeys?: readonly string[];
}

export interface AutoFixResult<N extends TellNode = TellNode> {
  tree: TellTree<N>;
  fixes: TellFix[];
  /** Tells the fix itself uncovered and could not settle (an emoji-only icon). */
  findings: TellFinding[];
}

// ---------------------------------------------------------------- shared helpers

type Style = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function styleOf(node: TellNode): Style {
  return isRecord(node.props.style) ? (node.props.style as Style) : {};
}

export function textOf(node: TellNode): string | undefined {
  return typeof node.props.children === 'string' ? node.props.children : undefined;
}

/** Every value of a style key: the scalar, or each entry of a responsive map. */
export function allValues(style: Style, key: string): string[] {
  const v = style[key];
  if (v === undefined || v === null) return [];
  if (isRecord(v)) return Object.values(v).filter((x) => x !== undefined && x !== null).map(String);
  return [String(v)];
}

/** The desktop value of a style key: the largest breakpoint's entry, else base, else the first entry. */
function primary(style: Style, key: string, opts: TellOptions): string | undefined {
  const v = style[key];
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) return String(v);
  const desktop = opts.breakpointKeys?.[0];
  if (desktop !== undefined && v[desktop] !== undefined) return String(v[desktop]);
  if (v.base !== undefined) return String(v.base);
  const first = Object.values(v)[0];
  return first === undefined ? undefined : String(first);
}

function pxValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value);
  return m ? Number(m[1]) : undefined;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CALL_TO_ACTION_TAGS = new Set(['a', 'button', 'ul', 'ol']);

export function walk(nodes: TellNode[], visit: (node: TellNode, path: string, ancestors: TellNode[]) => void): void {
  const go = (list: TellNode[], parentPath: string, ancestors: TellNode[]) => {
    const labelCount = new Map<string, number>();
    for (const n of list) labelCount.set(n.label, (labelCount.get(n.label) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const n of list) {
      const i = (seen.get(n.label) ?? 0) + 1;
      seen.set(n.label, i);
      const name = (labelCount.get(n.label) ?? 0) > 1 ? `${n.label} (${i})` : n.label;
      const path = parentPath ? `${parentPath} > ${name}` : name;
      visit(n, path, ancestors);
      go(n.children, path, [...ancestors, n]);
    }
  };
  go(nodes, '', []);
}

export function subtree(node: TellNode): TellNode[] {
  const out: TellNode[] = [];
  const go = (n: TellNode) => {
    out.push(n);
    n.children.forEach(go);
  };
  go(node);
  return out;
}

export function hasText(node: TellNode): boolean {
  return subtree(node).some((n) => (textOf(n) ?? '').trim().length > 0);
}

// ---------------------------------------------------------------- colour

interface Hsla {
  h: number;
  s: number;
  l: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  red: '#ff0000', orange: '#ffa500', yellow: '#ffff00', gold: '#ffd700', green: '#008000',
  lime: '#00ff00', teal: '#008080', cyan: '#00ffff', aqua: '#00ffff', blue: '#0000ff',
  navy: '#000080', indigo: '#4b0082', purple: '#800080', violet: '#ee82ee', fuchsia: '#ff00ff',
  magenta: '#ff00ff', pink: '#ffc0cb', blueviolet: '#8a2be2', darkviolet: '#9400d3',
  darkorchid: '#9932cc', mediumpurple: '#9370db', rebeccapurple: '#663399', slateblue: '#6a5acd',
  mediumslateblue: '#7b68ee', orchid: '#da70d6', plum: '#dda0dd', crimson: '#dc143c',
  coral: '#ff7f50', tomato: '#ff6347', salmon: '#fa8072', turquoise: '#40e0d0',
};

function rgbToHsla(r: number, g: number, b: number, a: number): Hsla {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s, l, a };
}

function hexToHsla(hex: string): Hsla | undefined {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return undefined;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return rgbToHsla(n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1);
}

function channel(v: string, max: number): number {
  const t = v.trim();
  if (t.endsWith('%')) return (parseFloat(t) / 100) * max;
  return parseFloat(t);
}

const COLOR_TOKEN = new RegExp(
  [
    '#[0-9a-fA-F]{3,8}\\b',
    'rgba?\\([^)]*\\)',
    'hsla?\\([^)]*\\)',
    `\\b(?:${Object.keys(NAMED).join('|')})\\b`,
  ].join('|'),
  'gi',
);

/** Every colour written in a CSS value (hex, rgb, hsl, a few names), in order. */
export function parseColors(value: string): Hsla[] {
  const out: Hsla[] = [];
  for (const m of value.matchAll(COLOR_TOKEN)) {
    const tok = m[0].toLowerCase();
    let c: Hsla | undefined;
    if (tok.startsWith('#')) c = hexToHsla(tok);
    else if (tok.startsWith('rgb') || tok.startsWith('hsl')) {
      const inner = tok.slice(tok.indexOf('(') + 1, -1);
      const parts = inner.split(/[\s,/]+/).filter(Boolean);
      if (parts.length >= 3) {
        const alpha = parts[3] !== undefined ? channel(parts[3], 1) : 1;
        if (tok.startsWith('rgb')) {
          c = rgbToHsla(channel(parts[0], 255), channel(parts[1], 255), channel(parts[2], 255), alpha);
        } else {
          c = { h: parseFloat(parts[0]), s: channel(parts[1], 1), l: channel(parts[2], 1), a: alpha };
        }
      }
    } else if (NAMED[tok]) c = hexToHsla(NAMED[tok]);
    if (c && [c.h, c.s, c.l, c.a].every(Number.isFinite)) out.push(c);
  }
  return out;
}

function isChromatic(c: Hsla, minS = 0.25): boolean {
  return c.a >= 0.3 && c.s >= minS && c.l >= 0.15 && c.l <= 0.9;
}

function isNearBlack(c: Hsla, maxL = 0.12): boolean {
  return c.a >= 0.6 && c.l <= maxL;
}

function isPurple(c: Hsla): boolean {
  return c.a >= 0.5 && c.h >= 240 && c.h <= 300 && c.s >= 0.4 && c.l >= 0.3 && c.l <= 0.8;
}

/** Clusters hues within 30 degrees; returns the clusters' representative hues. */
function hueClusters(hues: number[]): number[] {
  const sorted = [...hues].sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const h of sorted) {
    if (!clusters.some((c) => circularDistance(c, h) < 30)) clusters.push(h);
  }
  return clusters;
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The largest circular distance between any two hues. */
function hueSpread(hues: number[]): number {
  let max = 0;
  for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) max = Math.max(max, circularDistance(hues[i], hues[j]));
  return max;
}

interface Gradient {
  kind: 'linear' | 'radial' | 'conic';
  body: string;
}

/** The gradient functions in a background value, with balanced parentheses. */
export function parseGradients(value: string): Gradient[] {
  const out: Gradient[] = [];
  const re = /(?:repeating-)?(linear|radial|conic)-gradient\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < value.length && depth > 0) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')') depth -= 1;
      i += 1;
    }
    out.push({ kind: m[1].toLowerCase() as Gradient['kind'], body: value.slice(start, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

function backgroundValues(style: Style): string[] {
  return [...allValues(style, 'backgroundImage'), ...allValues(style, 'background')];
}

function gradientsOf(style: Style): Gradient[] {
  return backgroundValues(style).flatMap(parseGradients);
}

function hasUrl(style: Style): boolean {
  return backgroundValues(style).some((v) => /url\(/i.test(v));
}

/** Colour keys that paint a node (text, fill, border, shadow, gradient). */
const PAINT_KEYS = [
  'color', 'backgroundColor', 'background', 'backgroundImage', 'borderColor', 'border', 'borderTop',
  'borderRight', 'borderBottom', 'borderLeft', 'boxShadow', 'outline',
];

function paintColors(style: Style): Hsla[] {
  return PAINT_KEYS.flatMap((k) => allValues(style, k).flatMap(parseColors));
}

/** The surface colours of a node: backgroundColor, background, and gradient stops. */
function surfaceColors(style: Style): Hsla[] {
  return ['backgroundColor', 'background', 'backgroundImage'].flatMap((k) => allValues(style, k).flatMap(parseColors));
}

function isDarkSurface(style: Style, maxL: number): boolean {
  const surface = surfaceColors(style);
  return surface.length > 0 && surface.filter((c) => c.a >= 0.6).every((c) => c.l <= maxL) && surface.some((c) => isNearBlack(c, maxL));
}

function isLightSurface(style: Style): boolean {
  const solid = allValues(style, 'backgroundColor').flatMap(parseColors).filter((c) => c.a >= 0.6);
  return solid.length > 0 && solid.every((c) => c.l >= 0.5);
}

function isBox(node: TellNode): boolean {
  if (node.id.startsWith('card-')) return true;
  const s = styleOf(node);
  const bg = surfaceColors(s).some((c) => c.a > 0.05) || gradientsOf(s).length > 0;
  const border = allValues(s, 'border').some((v) => !/^\s*(none|0|0px)\b/.test(v)) || allValues(s, 'borderWidth').some((v) => pxValue(v) !== 0);
  const shadow = allValues(s, 'boxShadow').some((v) => v.trim() !== 'none');
  const rounded = allValues(s, 'borderRadius').some((v) => (pxValue(v) ?? parseFloat(v)) > 0) && s.padding !== undefined;
  return bg || border || shadow || rounded;
}

/** The structure of a node, ignoring text and styles, three levels deep. */
function signature(node: TellNode, depth = 3): string {
  if (depth === 0 || node.children.length === 0) return node.type;
  return `${node.type}(${node.children.map((c) => signature(c, depth - 1)).join(',')})`;
}

// ---------------------------------------------------------------- text fixes

const DASH_GLYPH = '[\\u2013\\u2014]';
/** A dash in copy: an em dash, an en dash, or a "--" that is not part of an arrow. */
const ANY_DASH = new RegExp(`${DASH_GLYPH}|(?<!<)--(?!>)`);

/** Replace em and en dashes in copy by punctuation (rule em-dash above). Idempotent. */
export function fixDashes(input: string): string {
  if (!ANY_DASH.test(input)) return input;
  let t = input;
  // Ranges: between digits, and an unspaced en dash between letters.
  t = t.replace(new RegExp(`(\\d)\\s*(?:${DASH_GLYPH}|--)\\s*(?=\\d)`, 'g'), '$1-');
  t = t.replace(/(\p{L})\u2013(?=\p{L})/gu, '$1-');
  // Leading and trailing dashes (an attribution, a dangling aside).
  t = t.replace(new RegExp(`^\\s*(?:${DASH_GLYPH}|--(?!>))\\s*`), '');
  t = t.replace(new RegExp(`\\s*(?:${DASH_GLYPH}|(?<!<)--)\\s*$`), '');
  // Asides, sentence by sentence.
  const aside = new RegExp(`\\s*(?:${DASH_GLYPH}|(?<!<)--(?!>))\\s*`, 'g');
  t = t
    .split(/(?<=[.!?])(\s+)/)
    .map((sentence) => {
      const matches = [...sentence.matchAll(aside)];
      if (matches.length === 0) return sentence;
      let out = '';
      let last = 0;
      matches.forEach((m, i) => {
        const before = sentence.slice(last, m.index);
        out += before;
        const lead = (out.match(/[^.!?:]*$/)?.[0] ?? '').trim();
        const endsWithPunct = /[,;:.!?]\s*$/.test(out);
        let sep: string;
        if (endsWithPunct) sep = ' ';
        else if (matches.length >= 2) sep = ', ';
        else if (i === 0 && lead.split(/\s+/).filter(Boolean).length <= 3 && lead.length > 0) sep = ': ';
        else sep = ', ';
        out = out.replace(/\s+$/, '') + sep;
        last = (m.index ?? 0) + m[0].length;
      });
      out += sentence.slice(last);
      return out;
    })
    .join('');
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}

const KEEP_PICTOGRAPHS = new Set(['©', '®', '™']);
const EMOJI_RE =
  /(?:[0-9#*]️?⃣)|(?:\p{Regional_Indicator}{1,2})|(?:\p{Extended_Pictographic}[︎️]?[\u{1F3FB}-\u{1F3FF}]?(?:‍\p{Extended_Pictographic}[︎️]?[\u{1F3FB}-\u{1F3FF}]?)*)/gu;

/** Remove emoji from copy (rule emoji above). Idempotent. */
export function stripEmoji(input: string): string {
  let changed = false;
  const out = input.replace(EMOJI_RE, (m) => {
    if (/^[0-9#*]/.test(m)) {
      changed = true;
      return m[0];
    }
    const base = m.replace(/[︎️]/g, '');
    if (KEEP_PICTOGRAPHS.has(base)) return m;
    changed = true;
    return '';
  });
  if (!changed) return input;
  return out
    .replace(/[️‍]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

function hasEmoji(input: string): boolean {
  return stripEmoji(input) !== input;
}

const TRAILING_ARROW = /\s*(?:-{1,2}>|=>|>{1,2}|[→⟶➔➜➝➞➟➠⇒↗›»])\s*$/u;

/** Remove a trailing arrow glyph from a button or link label (rule button-arrow). Idempotent. */
export function stripTrailingArrow(input: string): string {
  let t = input;
  while (TRAILING_ARROW.test(t)) {
    const next = t.replace(TRAILING_ARROW, '');
    if (next.trim().length === 0) return t; // an arrow-only label stays
    t = next;
  }
  return t;
}

export const BANNED_FONT_FAMILIES: ReadonlySet<string> = new Set([
  'inter', 'inter var', 'inter variable', 'inter display', 'inter tight', 'geist', 'geist sans', 'geist mono',
  'space grotesk',
]);
const GENERIC_ONLY = new Set(['sans-serif', 'serif', 'system-ui', 'ui-sans-serif', 'ui-serif', '-apple-system', 'blinkmacsystemfont']);

function families(stack: string): string[] {
  return stack.split(',').map((f) => f.trim()).filter(Boolean);
}

function normFamily(f: string): string {
  return f.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

/**
 * Remove banned families from one fontFamily stack. Returns the new stack,
 * undefined when nothing but generic families is left (drop the key), or the
 * input unchanged.
 */
export function stripBannedFonts(stack: string): string | undefined {
  const fams = families(stack);
  const kept = fams.filter((f) => !BANNED_FONT_FAMILIES.has(normFamily(f)));
  if (kept.length === fams.length) return stack;
  if (kept.every((f) => GENERIC_ONLY.has(normFamily(f)))) return undefined;
  return kept.join(', ');
}

function hasBannedFont(stack: string): boolean {
  return families(stack).some((f) => BANNED_FONT_FAMILIES.has(normFamily(f)));
}

function bannedInShorthand(value: string): boolean {
  const lower = value.toLowerCase();
  return [...BANNED_FONT_FAMILIES].some((f) => new RegExp(`(^|[\\s,'"])${f}($|[\\s,'"])`).test(lower));
}

// ---------------------------------------------------------------- copy patterns

/** "It's not X, it's Y" and its relatives (rule not-x-its-y). */
export const NOT_X_ITS_Y_PATTERNS: readonly RegExp[] = [
  /\b(?:it['’]?s|this is|that['’]?s|we['’]?re|we are|they['’]?re)\s+not\s+[^.!?]{1,80}?[,.;:]\s*(?:it['’]?s|this is|that['’]?s|we['’]?re|we are|they['’]?re)\b/i,
  /\bit['’]?s not about\b/i,
  /\b(?:isn['’]?t|aren['’]?t|is not|are not)\s+just\b/i,
  /\bmore than just\b/i,
  /(?:^|[.!?]\s+)not (?:a|an|another|your)\s+[^.!?,]{1,40}[.,;:]\s*(?:it['’]?s\s+)?(?:a|an|the)\s/i,
  /\bnot just\s+[^.!?]{1,60}?\bbut\b/i,
  /\b(?:ist|sind)\s+nicht\s+[^.!?]{1,80}?[,.]\s*(?:es|das|sie|wir)\s+(?:ist|sind)\b/i,
  /\bmehr als nur\b/i,
  /\bkein(?:e|en|er)?\s+[^.!?,]{1,40},\s*sondern\b/i,
  // The trailing contrast clause: "Back on the road in days, not weeks."
  /\w,\s+not\s+[^.!?,;:]{2,30}[.!]?\s*$/i,
  /\w,\s+nicht\s+[^.!?,;:]{2,30}[.!]?\s*$/i,
];

function matchesNotXItsY(text: string): boolean {
  return NOT_X_ITS_Y_PATTERNS.some((re) => re.test(text));
}

const SPARKLE_RE = /[✦✧✨✳✴❇✶-✺]/u;

const PROMPT_LINE = /(?:^|\n)\s*(?:\$|>|❯|➜|%|~\s*\$|[\w.-]+@[\w.-]+:?[~/\w]*\s*\$)\s+\S/;
const MONO = /mono|courier|consolas|menlo|monaco/i;
const ICON_SET_SRC = /lucide|heroicons|feathericons|feather-icons|tabler-icons|phosphor-icons|@phosphor/i;

// ---------------------------------------------------------------- autoFix

interface MutableFixes {
  counts: Map<TellId, { count: number; paths: string[] }>;
  findings: TellFinding[];
}

function noteFix(f: MutableFixes, tell: TellId, path: string): void {
  const entry = f.counts.get(tell) ?? { count: 0, paths: [] };
  entry.count += 1;
  if (entry.paths.length < 3 && !entry.paths.includes(path)) entry.paths.push(path);
  f.counts.set(tell, entry);
}

const FIX_TEXT: Record<string, (n: number, where: string) => string> = {
  'em-dash': (n, w) => `Design: replaced em and en dashes with punctuation in ${n} ${n === 1 ? 'text' : 'texts'} (${w})`,
  emoji: (n, w) => `Design: removed emoji from ${n} ${n === 1 ? 'text' : 'texts'} (${w})`,
  'emoji-icon': (n, w) => `Design: removed ${n} emoji-only icon ${n === 1 ? 'node' : 'nodes'} (${w})`,
  'banned-font': (n, w) => `Design: removed Inter, Geist or Space Grotesk from the font stack of ${n} ${n === 1 ? 'node' : 'nodes'}, the page font applies (${w})`,
  'button-arrow': (n, w) => `Design: removed the trailing arrow from ${n} button or link ${n === 1 ? 'label' : 'labels'} (${w})`,
};

function fixCopy(text: string, f: MutableFixes, path: string): string {
  let t = text;
  const noEmoji = stripEmoji(t);
  if (noEmoji !== t) {
    noteFix(f, 'emoji', path);
    t = noEmoji;
  }
  const noDash = fixDashes(t);
  if (noDash !== t) {
    noteFix(f, 'em-dash', path);
    t = noDash;
  }
  return t;
}

function fixFontStyle(style: Style, f: MutableFixes, path: string): Style {
  const ff = style.fontFamily;
  if (ff === undefined) return style;
  let changed = false;
  let next: unknown = ff;
  if (isRecord(ff)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ff)) {
      if (typeof v !== 'string') {
        out[k] = v;
        continue;
      }
      const s = stripBannedFonts(v);
      if (s !== v) changed = true;
      if (s !== undefined) out[k] = s;
    }
    next = Object.keys(out).length > 0 ? out : undefined;
  } else if (typeof ff === 'string') {
    const s = stripBannedFonts(ff);
    if (s !== ff) changed = true;
    next = s;
  }
  if (!changed) return style;
  noteFix(f, 'banned-font', path);
  const copy = { ...style };
  if (next === undefined) delete copy.fontFamily;
  else copy.fontFamily = next;
  return copy;
}

/**
 * Apply the safe fixes (em-dash, emoji, banned-font, button-arrow) and return
 * a new tree, the aggregated fixes and any finding the fix uncovered. Running
 * it on its own output changes nothing (idempotent).
 */
export function autoFixTells<N extends TellNode>(tree: TellTree<N>, opts: TellOptions = {}): AutoFixResult<N> {
  const f: MutableFixes = { counts: new Map(), findings: [] };
  const photo = opts.photoNodeIds ?? new Set<string>();

  const fixList = (list: N[], parentPath: string, inLink: boolean): N[] => {
    const labelCount = new Map<string, number>();
    for (const n of list) labelCount.set(n.label, (labelCount.get(n.label) ?? 0) + 1);
    const seen = new Map<string, number>();
    const out: N[] = [];
    for (const node of list) {
      const i = (seen.get(node.label) ?? 0) + 1;
      seen.set(node.label, i);
      const name = (labelCount.get(node.label) ?? 0) > 1 ? `${node.label} (${i})` : node.label;
      const path = parentPath ? `${parentPath} > ${name}` : name;
      const link = inLink || node.type === 'a' || node.type === 'button';

      const props: Record<string, unknown> = { ...node.props };
      let removed = false;
      const text = textOf(node);
      if (text !== undefined) {
        let t = text;
        const stripped = stripEmoji(t);
        if (stripped.trim().length === 0 && t.trim().length > 0 && node.children.length === 0 && !photo.has(node.id)) {
          // Only emoji: an icon stand-in. Remove the node, report it.
          noteFix(f, 'emoji-icon', path);
          f.findings.push({
            tell: 'emoji-icon',
            path,
            detail:
              'an emoji was used as an icon (removed). Give this spot a real visual (a photo, a number, a short word) or leave it out, and remove an icon box it leaves empty.',
            autoFixable: false,
          });
          removed = true;
        } else {
          t = fixCopy(t, f, path);
          if (link) {
            const noArrow = stripTrailingArrow(t);
            if (noArrow !== t) {
              noteFix(f, 'button-arrow', path);
              t = noArrow;
            }
          }
          if (t !== text) props.children = t;
        }
      }
      if (removed) continue;
      if (typeof props.alt === 'string') {
        const alt = fixCopy(props.alt, f, path);
        if (alt !== props.alt) props.alt = alt;
      }
      if (isRecord(props.style)) {
        const fixed = fixFontStyle(props.style as Style, f, path);
        if (fixed !== props.style) props.style = fixed;
      }
      const children = fixList(node.children as N[], path, link);
      out.push({ ...node, props, children });
    }
    return out;
  };

  const nodes = fixList(tree.nodes, '', false);
  const result: TellTree<N> = { ...tree, nodes: nodes.length > 0 ? nodes : tree.nodes };
  if (tree.title !== undefined) result.title = fixCopy(tree.title, f, 'page title');
  if (tree.description !== undefined) result.description = fixCopy(tree.description, f, 'page description');

  const fixes: TellFix[] = [...f.counts.entries()].map(([tell, { count, paths }]) => ({
    tell,
    count,
    detail: (FIX_TEXT[tell] ?? ((n: number, w: string) => `Design: fixed ${tell} ${n} times (${w})`))(
      count,
      paths.join(', ') + (count > paths.length ? ', ...' : ''),
    ),
  }));
  return { tree: result, fixes, findings: f.findings };
}

// ---------------------------------------------------------------- detection

function gridTrackCount(value: string | undefined): number | 'auto' | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/repeat\(\s*auto-(?:fit|fill)/i.test(v)) return 'auto';
  let count = 0;
  let depth = 0;
  let token = '';
  const flush = () => {
    if (token.trim()) {
      const rep = /^repeat\(\s*(\d+)\s*,/i.exec(token.trim());
      count += rep ? Number(rep[1]) : 1;
    }
    token = '';
  };
  for (const ch of v) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) flush();
    else token += ch;
  }
  flush();
  return count;
}

function isRow(node: TellNode, opts: TellOptions): { row: boolean; grid: boolean } {
  const s = styleOf(node);
  const display = primary(s, 'display', opts);
  if (display === 'flex' || display === 'inline-flex') {
    const dir = primary(s, 'flexDirection', opts);
    return { row: dir === undefined || dir === 'row' || dir === 'row-reverse', grid: false };
  }
  if (display === 'grid' || display === 'inline-grid') {
    const tracks = gridTrackCount(primary(s, 'gridTemplateColumns', opts));
    return { row: tracks === 'auto' || (typeof tracks === 'number' && tracks >= 3), grid: true };
  }
  return { row: false, grid: false };
}

function isFeatureCard(node: TellNode): boolean {
  if (!isBox(node) || node.children.length === 0 || node.children.length > 4) return false;
  const all = subtree(node).slice(1);
  if (all.some((n) => CALL_TO_ACTION_TAGS.has(n.type))) return false;
  const heading = all.some((n) => HEADING_TAGS.has(n.type) && (textOf(n) ?? '').trim());
  const body = all.some((n) => !HEADING_TAGS.has(n.type) && (textOf(n) ?? '').trim());
  return heading && body;
}

function spansTracks(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  const span = /span\s+(\d+)/i.exec(v);
  if (span) return Number(span[1]) >= 2;
  const lines = /^(-?\d+)\s*\/\s*(-?\d+)$/.exec(v);
  if (lines) {
    const a = Number(lines[1]);
    const b = Number(lines[2]);
    if (b < 0 || a < 0) return false; // 1 / -1: a full-row cell, not a tile size
    return b - a >= 2;
  }
  return false;
}

function areasSpan(value: string | undefined): { spans: boolean; areas: number } {
  if (!value) return { spans: false, areas: 0 };
  const cells = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].flatMap((m) => (m[1] ?? m[2]).trim().split(/\s+/));
  const counts = new Map<string, number>();
  for (const c of cells) if (c !== '.') counts.set(c, (counts.get(c) ?? 0) + 1);
  return { spans: [...counts.values()].some((n) => n > 1), areas: counts.size };
}

function finding(tell: TellId, path: string, detail: string, autoFixable = false): TellFinding {
  return { tell, path, detail, autoFixable };
}

/**
 * Every tell visible in the tree. Run it after autoFixTells to get what is
 * left for the repair round (the autoFixable ones are then gone).
 */
export function detectTells(tree: TellTree, opts: TellOptions = {}): TellFinding[] {
  const out: TellFinding[] = [];
  const photo = opts.photoNodeIds ?? new Set<string>();

  // ---- copy: page title and description
  for (const [path, text] of [['page title', tree.title], ['page description', tree.description]] as const) {
    if (!text) continue;
    copyFindings(text, path, out, false);
  }

  let cards = 0;
  let animatedCards = 0;
  const reportedDark = new Set<string>();
  const reportedTerminal = new Set<string>();
  const reportedFake = new Set<string>();

  walk(tree.nodes, (node, path, ancestors) => {
    const s = styleOf(node);
    const text = textOf(node);
    const inLink = node.type === 'a' || node.type === 'button' || ancestors.some((a) => a.type === 'a' || a.type === 'button');

    // ---- copy
    if (text) {
      copyFindings(text, path, out, inLink);
      if (stripEmoji(text).trim().length === 0 && text.trim().length > 0) {
        out.push(finding('emoji-icon', path, 'an emoji is used as an icon. Use a real visual (a photo, a number, a short word) or none.'));
      }
    }
    if (typeof node.props.alt === 'string') copyFindings(node.props.alt, path, out, false);
    if (/sparkle/i.test(node.label)) {
      out.push(finding('sparkle', path, 'a sparkle icon (the generic "AI" star). Remove it; let the copy carry the point.'));
    }

    // ---- fonts
    if (allValues(s, 'fontFamily').some(hasBannedFont)) {
      out.push(finding('banned-font', path, 'Inter, Geist or Space Grotesk in fontFamily. Use the page\'s display and body stacks.', true));
    }
    if (allValues(s, 'font').some(bannedInShorthand)) {
      out.push(finding('banned-font', path, 'Inter, Geist or Space Grotesk in the font shorthand. Use fontFamily with the page\'s stacks instead.'));
    }

    // ---- icon sets
    if (node.type === 'img' && typeof node.props.src === 'string' && ICON_SET_SRC.test(node.props.src)) {
      out.push(finding('icon-set', path, 'an icon from a stock icon set (Lucide and similar). Use a photo, a number or typography instead of decorative icons.'));
    }

    // ---- glass
    const sticky = ['sticky', 'fixed'].includes(primary(s, 'position', opts) ?? '');
    if (allValues(s, 'backdropFilter').some((v) => /blur\(\s*[1-9]/.test(v)) && !(node.type === 'header' || node.type === 'nav' || sticky)) {
      out.push(finding('glass', path, 'decorative frosted glass (backdropFilter blur). Use a solid or slightly tinted surface instead.'));
    }

    // ---- gradients
    const gradients = gradientsOf(s);
    const bgSizes = allValues(s, 'backgroundSize');
    const smallTile = bgSizes.some((v) => {
      const nums = [...v.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
      return nums.length > 0 && nums.every((n) => n <= 80);
    });
    if (gradients.length > 0 && smallTile) {
      const radial = gradients.some((g) => g.kind === 'radial');
      out.push(
        finding(
          'dot-grid',
          path,
          `a ${radial ? 'dot' : 'line'} grid pattern as a background. Use a plain or tinted surface, or a real photo.`,
        ),
      );
    } else if (gradients.some((g) => g.kind === 'radial' && parseColors(g.body).some((c) => isChromatic(c)))) {
      out.push(finding('radial-orb', path, 'a coloured radial-gradient glow (an "orb"). Use a flat or tinted surface; a scrim over a photo may stay.'));
    }
    const blur = allValues(s, 'filter').map((v) => /blur\(\s*(\d+(?:\.\d+)?)px/.exec(v)).find(Boolean);
    if (blur && Number(blur[1]) >= 16 && !hasText(node) && (surfaceColors(s).some((c) => isChromatic(c)) || gradients.length > 0)) {
      out.push(finding('radial-orb', path, 'a blurred colour blob as decoration. Remove it.'));
    }
    for (const g of gradients) {
      const hues = parseColors(g.body).filter((c) => isChromatic(c, 0.35)).map((c) => c.h);
      const clusters = hueClusters(hues);
      if (clusters.length >= 3 && hueSpread(clusters) >= 90) {
        out.push(finding('rainbow', path, 'a multi-colour (rainbow) gradient. Use one brand hue, or a single-hue tint.'));
        break;
      }
    }
    if (allValues(s, 'backgroundClip').some((v) => /text/i.test(v)) && gradients.length > 0) {
      out.push(finding('gradient-text', path, 'gradient text. Set the text in one solid colour from the palette.'));
    }

    // ---- placeholder demos
    if (!photo.has(node.id) && node.type !== 'img') {
      const media =
        primary(s, 'aspectRatio', opts) !== undefined ||
        (pxValue(primary(s, 'height', opts)) ?? 0) >= 120 ||
        (pxValue(primary(s, 'minHeight', opts)) ?? 0) >= 120;
      const sub = subtree(node);
      const noContent = !hasText(node) && !sub.some((n) => n.type === 'img' || photo.has(n.id));
      const insideReported = ancestors.some((a) => reportedFake.has(a.id));
      if (!insideReported && noContent && gradients.length > 0 && !hasUrl(s) && media) {
        reportedFake.add(node.id);
        out.push(finding('placeholder-demo', path, 'a gradient box standing in for a product shot. Use an img with an imageQuery for a real photo, or remove it.'));
      } else if (!insideReported && noContent && sub.length >= 5) {
        reportedFake.add(node.id);
        out.push(finding('placeholder-demo', path, 'a fake screen built from empty boxes. Use an img with an imageQuery for a real photo, or remove it.'));
      }
    }

    // ---- purple on near-black (one finding per outermost dark root)
    if (!photo.has(node.id) && !hasUrl(s) && isDarkSurface(s, 0.12) && !ancestors.some((a) => reportedDark.has(a.id))) {
      const purple = darkSubtreePurple(node);
      if (purple > 0) {
        reportedDark.add(node.id);
        out.push(finding('purple-on-black', path, 'violet or purple accents on a near-black background. Pick an accent from the brand, or a warm or neutral dark surface.'));
      }
    }

    // ---- terminal mock-ups
    if (isDarkSurface(s, 0.2) && !ancestors.some((a) => reportedTerminal.has(a.id))) {
      const sub = subtree(node);
      const monoText = monospaceText(node, ancestors);
      const promptLine = monoText.some((t) => PROMPT_LINE.test(t));
      const dots = sub.some((n) => {
        const round = n.children.filter((c) => {
          const cs = styleOf(c);
          const w = pxValue(primary(cs, 'width', opts));
          const r = primary(cs, 'borderRadius', opts) ?? '';
          return w !== undefined && w <= 16 && (/50%/.test(r) || (pxValue(r) ?? 0) >= w / 2);
        });
        return round.length >= 3;
      });
      if (monoText.length > 0 && (promptLine || dots)) {
        reportedTerminal.add(node.id);
        out.push(finding('terminal', path, 'a terminal window as decoration. Show the product with a real photo or plain copy instead.'));
      }
    }

    // ---- rows of children
    const kids = node.children;
    if (kids.length >= 3) {
      const { row, grid } = isRow(node, opts);
      if (row) {
        const groups = new Map<string, number>();
        for (const k of kids) if (isFeatureCard(k)) groups.set(signature(k), (groups.get(signature(k)) ?? 0) + 1);
        const best = Math.max(0, ...groups.values());
        if (best >= 3) {
          out.push(
            finding(
              'feature-cards',
              path,
              `${best} identical cards (heading and text) side by side. Use another layout: an editorial list (a heading column beside text rows), one large item with smaller ones, or a strip of figures.`,
            ),
          );
        }
      }
      if (grid && kids.length >= 4) {
        const tiles = kids.filter((k) => isBox(k) || k.type === 'img');
        const spans = kids.some(
          (k) => spansTracks(primary(styleOf(k), 'gridColumn', opts)) || spansTracks(primary(styleOf(k), 'gridRow', opts)),
        );
        const areas = areasSpan(primary(s, 'gridTemplateAreas', opts));
        if (tiles.length >= 4 && (spans || (areas.spans && areas.areas >= 4))) {
          out.push(finding('bento-grid', path, 'a bento grid (tiles of mixed sizes). Use editorial rows, a split, or a simple list instead.'));
        }
      }
      // rainbow card set
      const filled = kids
        .filter((k) => isBox(k))
        .map((k) => allValues(styleOf(k), 'backgroundColor').flatMap(parseColors).find((c) => isChromatic(c, 0.4)))
        .filter((c): c is Hsla => !!c);
      if (filled.length >= 3) {
        const clusters = hueClusters(filled.map((c) => c.h));
        if (clusters.length >= 3 && hueSpread(clusters) >= 120) {
          out.push(finding('rainbow', path, 'sibling cards in rainbow colours. Give them one surface colour; use the accent only for calls to action.'));
        }
      }
    }

    // ---- hover everywhere (counted, reported once below)
    if (node.children.length > 0 && isBox(node) && node.type !== 'section' && node.type !== 'header' && node.type !== 'footer') {
      cards += 1;
      if (allValues(s, 'transition').some((v) => v.trim() !== 'none')) animatedCards += 1;
    }
  });

  if (animatedCards >= 3 && animatedCards / Math.max(cards, 1) >= 0.6) {
    out.push(
      finding(
        'hover-everywhere',
        'page',
        `${animatedCards} of ${cards} cards carry a transition (hover animation everywhere). Remove transition and transform from cards; keep motion for one or two key elements.`,
      ),
    );
  }
  return out;
}

function copyFindings(text: string, path: string, out: TellFinding[], inLink: boolean): void {
  if (ANY_DASH.test(text)) {
    out.push(finding('em-dash', path, 'an em or en dash in copy. Use a comma, colon, parentheses or a new sentence.', true));
  }
  if (hasEmoji(text)) out.push(finding('emoji', path, 'emoji in copy. Remove them.', true));
  if (inLink && stripTrailingArrow(text) !== text) {
    out.push(finding('button-arrow', path, 'an arrow glyph after a button label. Write the label alone.', true));
  }
  if (matchesNotXItsY(text)) {
    out.push(
      finding(
        'not-x-its-y',
        path,
        `"not X, it's Y" copy ("${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"). Say plainly what it is, without the contrast.`,
      ),
    );
  }
  if (SPARKLE_RE.test(text)) {
    out.push(finding('sparkle', path, 'a sparkle glyph (the generic "AI" star). Remove it.'));
  }
}

function darkSubtreePurple(root: TellNode): number {
  let count = 0;
  const go = (n: TellNode) => {
    const s = styleOf(n);
    if (n !== root && isLightSurface(s)) return; // a light card inside the dark section breaks the context
    if (paintColors(s).some(isPurple)) count += 1;
    n.children.forEach(go);
  };
  go(root);
  return count;
}

function monospaceText(root: TellNode, ancestors: TellNode[]): string[] {
  const inherited = [...ancestors].reverse().map((a) => allValues(styleOf(a), 'fontFamily')[0]).find(Boolean);
  const out: string[] = [];
  const go = (n: TellNode, font: string | undefined) => {
    const own = allValues(styleOf(n), 'fontFamily')[0];
    const effective = own ?? font;
    const t = textOf(n);
    if (t && effective && MONO.test(effective)) out.push(t);
    n.children.forEach((c) => go(c, effective));
  };
  go(root, inherited);
  return out;
}

/** Recount a tree's size after autoFixTells removed nodes (the result's stats). */
export function treeStats(nodes: TellNode[]): { nodeCount: number; maxDepth: number } {
  let nodeCount = 0;
  let maxDepth = 0;
  const go = (n: TellNode, depth: number) => {
    nodeCount += 1;
    if (depth > maxDepth) maxDepth = depth;
    n.children.forEach((c) => go(c, depth + 1));
  };
  nodes.forEach((n) => go(n, 1));
  return { nodeCount, maxDepth };
}

/** The repair-round line for one finding. */
export function describeFinding(f: TellFinding): string {
  return `${f.path}: ${f.detail}`;
}

// ---------------------------------------------------------------- single values
//
// The same rules, for one value a patch would write (the visual review's
// update_style / update_text). A patch cannot see the tree-shaped tells
// (three equal cards, bento grids), so only the value-level ones apply.

const LONG_DASH = new RegExp(DASH_GLYPH);

/** Why one style value would add a tell, or null. */
export function styleValueTell(property: string, value: string): string | null {
  if (LONG_DASH.test(value)) return 'long dashes are a tell';
  if (property === 'fontFamily' && hasBannedFont(value)) return 'Inter, Geist and Space Grotesk are banned typefaces';
  if (property === 'font' && bannedInShorthand(value)) return 'Inter, Geist and Space Grotesk are banned typefaces';
  if ((property === 'backdropFilter' || property === 'WebkitBackdropFilter') && /blur\(/i.test(value)) return 'backdrop-filter glass is a tell';
  const gradients = parseGradients(value);
  if (gradients.some((g) => g.kind === 'radial' && parseColors(g.body).some((c) => isChromatic(c)))) return 'a coloured radial-gradient orb is a tell';
  for (const g of gradients) {
    const clusters = hueClusters(parseColors(g.body).filter((c) => isChromatic(c, 0.35)).map((c) => c.h));
    if (clusters.length >= 3 && hueSpread(clusters) >= 90) return 'a multi-colour (rainbow) gradient is a tell';
  }
  return null;
}

/** Why one piece of copy would add a tell, or null. */
export function textTell(text: string): string | null {
  if (LONG_DASH.test(text)) return 'long dashes are a tell';
  if (stripEmoji(text) !== text) return 'emoji in copy are a tell';
  if (matchesNotXItsY(text)) return '"it\'s not X, it\'s Y" copy is a tell';
  return null;
}
