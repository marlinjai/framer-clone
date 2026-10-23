// src/lib/ai/review/layoutAudit.ts
//
// The deterministic half of the visual review pass: classify layout problems
// from MEASURED numbers. All DOM reads live in ./measureDom.ts, which turns a
// rendered breakpoint frame into the plain `FrameMeasurement` below; this file
// is pure, so every rule is tested on synthetic numbers (jsdom has no layout).
//
// Units: every box is in LAYOUT px relative to the frame's content box, never
// screen px. The canvas camera scales the frames; the runner divides by that
// zoom, so the numbers here match the CSS the model writes.
//
// Rules (kind, what it means):
//   text-clipped        a text element's content is taller or wider than its
//                       own box and the box hides the overflow, or the text
//                       reaches outside an ancestor that clips (overflow other
//                       than visible). The reader loses words.
//   text-overflow       a text element's content spills out of its own box
//                       (overflow visible): it paints over whatever follows.
//   child-overflow      an in-flow child extends past its parent's box while
//                       the parent does not clip: the parent is too small for
//                       its content, the classic "card collides with its
//                       button" shape.
//   overlap             two in-flow siblings intersect although neither is
//                       intentionally layered (see below).
//   horizontal-overflow on the smallest breakpoint, a node reaches past the
//                       frame's width (the page would scroll sideways on a
//                       phone). Only the outermost such node is reported.
//   headline-lines      display text (32px and up) wraps onto too many lines.
//   orphan              display text ends with a single word on its last line.
//   low-contrast        text over a solid background is under the WCAG 2.2 AA
//                       ratio (4.5:1, or 3:1 for large text: 24px and up, or
//                       18.66px and up at weight 700 or more).
//   image-text-contrast text over a photo, estimated: the photo's pixels are
//                       never sampled. The photo is assumed bright under light
//                       text and dark under dark text (the unfavourable case
//                       for a busy photo), every gradient layer between the
//                       text and the photo (the scrim) is composited at its
//                       average colour, and the result must reach the same
//                       WCAG thresholds. Text straight on a photo without a
//                       scrim therefore always fails, by design.
//
// Intentional layering (never reported as overlap or overflow): a node that
// is positioned absolute, fixed or sticky, has a negative margin, carries a
// transform, or is placed explicitly on a grid (gridArea / gridRow /
// gridColumn), because those are the ways this editor's CSS layers one thing
// over another on purpose. Everything else that intersects is accidental.

/** A rectangle in layout px, relative to the frame's content box. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MeasuredText {
  /** The element's own text (first 120 characters), for the message. */
  content: string;
  fontSizePx: number;
  fontWeight: number;
  /** Words on each rendered line, top to bottom (display text only). */
  wordsPerLine?: number[];
}

/** One rendered component in one breakpoint frame. */
export interface MeasuredNode {
  id: string;
  /** The nearest rendered ancestor component; undefined for the page root. */
  parentId?: string;
  tag: string;
  box: Box;
  /** Own content box and scroll sizes; undefined for inline boxes (no client size). */
  clientW?: number;
  clientH?: number;
  scrollW?: number;
  scrollH?: number;
  overflowX: string;
  overflowY: string;
  position: string;
  display: string;
  /** Any margin side is negative. */
  negativeMargin: boolean;
  /** A transform other than none. */
  transformed: boolean;
  /** Placed explicitly on a grid (gridArea / gridRow / gridColumn other than auto). */
  gridPlaced: boolean;
  /** Present when the element has its own (non-whitespace) text. */
  text?: MeasuredText;
  /** Computed colour strings. */
  color: string;
  backgroundColor: string;
  backgroundImage: string;
}

export interface FrameMeasurement {
  /** The breakpoint key ("desktop", "phone"). */
  breakpoint: string;
  /** Frame width in layout px. */
  width: number;
  isSmallest: boolean;
  /** The content box's scroll width (wider than `width` means something reaches out). */
  contentScrollWidth: number;
  nodes: MeasuredNode[];
}

export type FindingKind =
  | 'text-clipped'
  | 'text-overflow'
  | 'child-overflow'
  | 'overlap'
  | 'horizontal-overflow'
  | 'headline-lines'
  | 'orphan'
  | 'low-contrast'
  | 'image-text-contrast';

export interface LayoutFinding {
  kind: FindingKind;
  severity: 'error' | 'warning';
  nodeId: string;
  /** The breakpoint key the problem shows on. */
  breakpoint: string;
  /** The other node involved (the sibling, the clipping ancestor, the parent). */
  relatedNodeId?: string;
  /** The measured numbers behind the finding, rounded. */
  measured: Record<string, number | string>;
  message: string;
}

/** Tolerance for sub-pixel rounding, in layout px. */
const EPS = 2;
/** Font size from which text counts as display text (headline rules). */
export const DISPLAY_FONT_PX = 32;
/** Most siblings compared pairwise under one parent (bounds the n^2 overlap scan). */
const MAX_SIBLINGS = 40;

const round = (n: number) => Math.round(n * 10) / 10;
const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;
const clips = (overflow: string) => overflow !== 'visible' && overflow !== '';
const quote = (n: MeasuredNode) => (n.text ? `"${n.text.content.slice(0, 40)}${n.text.content.length > 40 ? '...' : ''}"` : `<${n.tag}>`);

/** Layered on purpose (see the header): never an accidental overlap or overflow. */
export function isIntentionallyLayered(n: MeasuredNode): boolean {
  return (
    n.position === 'absolute' ||
    n.position === 'fixed' ||
    n.position === 'sticky' ||
    n.negativeMargin ||
    n.transformed ||
    n.gridPlaced
  );
}

const rendered = (n: MeasuredNode) => n.display !== 'none' && n.display !== 'contents' && n.box.w > 0 && n.box.h > 0;

/** How far `inner` reaches past `outer` on each side (positive = outside). */
function excess(inner: Box, outer: Box): { left: number; right: number; top: number; bottom: number } {
  return {
    left: outer.x - inner.x,
    right: right(inner) - right(outer),
    top: outer.y - inner.y,
    bottom: bottom(inner) - bottom(outer),
  };
}

// ---------- colour ----------

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse a computed colour: rgb()/rgba() (comma or space syntax), #hex, or transparent. */
export function parseColor(input: string): Rgba | undefined {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return undefined;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (!fn) return undefined;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  const out = { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
  return [out.r, out.g, out.b, out.a].every(Number.isFinite) ? out : undefined;
}

/** Every colour inside a CSS value (gradient stops), in order. */
export function colorsIn(value: string): Rgba[] {
  const out: Rgba[] = [];
  for (const m of value.matchAll(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/gi)) {
    const c = parseColor(m[0]);
    if (c) out.push(c);
  }
  return out;
}

/** `top` painted over an opaque `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
    a: 1,
  };
}

/** The average of gradient stops (premultiplied, so a transparent stop thins the layer). */
function averageColor(stops: Rgba[]): Rgba {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const a = stops.reduce((s, c) => s + c.a, 0) / stops.length;
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (k: 'r' | 'g' | 'b') => stops.reduce((s, c) => s + c[k] * c.a, 0) / stops.length / a;
  return { r: ch('r'), g: ch('g'), b: ch('b'), a };
}

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio of two opaque colours (1 to 21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG large text: 24px and up, or 18.66px (14pt) and up when bold. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
/** The assumed photo behind light text: a bright, busy photo (the unfavourable case). */
const ASSUMED_BRIGHT_PHOTO: Rgba = { r: 200, g: 200, b: 200, a: 1 };
/** The assumed photo behind dark text. */
const ASSUMED_DARK_PHOTO: Rgba = { r: 56, g: 56, b: 56, a: 1 };

const hasPhoto = (bg: string) => /url\(/i.test(bg);
const gradientLayers = (bg: string) => (bg && bg !== 'none' ? bg.split(/(?=(?:repeating-)?(?:linear|radial|conic)-gradient\()/i) : [])
  .filter((l) => /gradient\(/i.test(l));

interface BackgroundEstimate {
  color: Rgba;
  overPhoto: boolean;
  /** The node whose background decided it. */
  fromId?: string;
  scrim: boolean;
}

/**
 * The background behind a text node: walk up from the node through its
 * ancestors collecting background layers until an opaque colour or a photo,
 * then composite them bottom-up. The frame itself is white.
 */
export function estimateBackground(
  node: MeasuredNode,
  byId: ReadonlyMap<string, MeasuredNode>,
  textColor: Rgba,
): BackgroundEstimate {
  const layers: Rgba[] = []; // top first
  let base: Rgba = WHITE;
  let overPhoto = false;
  let scrim = false;
  let fromId: string | undefined;
  let cur: MeasuredNode | undefined = node;
  let guard = 0;
  while (cur && guard++ < 200) {
    const bgImage = cur.backgroundImage ?? 'none';
    if (bgImage !== 'none') {
      const grads = gradientLayers(bgImage).map((g) => averageColor(colorsIn(g)));
      if (hasPhoto(bgImage)) {
        layers.push(...grads);
        scrim = grads.some((g) => g.a > 0);
        overPhoto = true;
        base = relativeLuminance(composite(textColor, WHITE)) > 0.5 ? ASSUMED_BRIGHT_PHOTO : ASSUMED_DARK_PHOTO;
        fromId = cur.id;
        break;
      }
      layers.push(...grads);
    }
    const bg = parseColor(cur.backgroundColor ?? '');
    if (bg && bg.a > 0) {
      if (bg.a >= 1) {
        base = bg;
        fromId = cur.id;
        break;
      }
      layers.push(bg);
    }
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  let color = base;
  for (let i = layers.length - 1; i >= 0; i--) color = composite(layers[i], color);
  return { color, overPhoto, fromId, scrim };
}

// ---------- the rules ----------

function textBoxRules(n: MeasuredNode, frame: FrameMeasurement, out: LayoutFinding[]): void {
  if (!n.text || n.clientW === undefined || n.clientH === undefined) return;
  const overH = (n.scrollH ?? 0) - n.clientH;
  const overW = (n.scrollW ?? 0) - n.clientW;
  if (overH <= EPS && overW <= EPS) return;
  const hidden = (overH > EPS && clips(n.overflowY)) || (overW > EPS && clips(n.overflowX));
  const measured = {
    contentHeight: round(n.scrollH ?? 0),
    boxHeight: round(n.clientH),
    contentWidth: round(n.scrollW ?? 0),
    boxWidth: round(n.clientW),
  };
  out.push({
    kind: hidden ? 'text-clipped' : 'text-overflow',
    severity: 'error',
    nodeId: n.id,
    breakpoint: frame.breakpoint,
    measured,
    message: hidden
      ? `Text ${quote(n)} is cut off by its own box: the content needs ${measured.contentWidth}x${measured.contentHeight}px but the box is ${measured.boxWidth}x${measured.boxHeight}px and hides the rest.`
      : `Text ${quote(n)} spills out of its box: the content needs ${measured.contentWidth}x${measured.contentHeight}px but the box is ${measured.boxWidth}x${measured.boxHeight}px.`,
  });
}

/** Text reaching outside the nearest ancestor that clips. */
function ancestorClipRule(
  n: MeasuredNode,
  byId: ReadonlyMap<string, MeasuredNode>,
  frame: FrameMeasurement,
  out: LayoutFinding[],
): void {
  if (!n.text) return;
  let cur = n.parentId ? byId.get(n.parentId) : undefined;
  let guard = 0;
  while (cur && guard++ < 200) {
    if (clips(cur.overflowX) || clips(cur.overflowY)) {
      const e = excess(n.box, cur.box);
      const horizontal = clips(cur.overflowX) ? Math.max(e.left, e.right) : 0;
      const vertical = clips(cur.overflowY) ? Math.max(e.top, e.bottom) : 0;
      const worst = Math.max(horizontal, vertical);
      if (worst > EPS) {
        out.push({
          kind: 'text-clipped',
          severity: 'error',
          nodeId: n.id,
          breakpoint: frame.breakpoint,
          relatedNodeId: cur.id,
          measured: { cutOffPx: round(worst), textHeight: round(n.box.h), clipHeight: round(cur.box.h) },
          message: `Text ${quote(n)} is cut off by ${quote(cur)}, which hides overflow: ${round(worst)}px of the text are outside it.`,
        });
      }
      return; // the nearest clipping ancestor decides
    }
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
}

function childOverflowRule(
  n: MeasuredNode,
  byId: ReadonlyMap<string, MeasuredNode>,
  frame: FrameMeasurement,
  out: LayoutFinding[],
): void {
  if (!n.parentId || isIntentionallyLayered(n)) return;
  const parent = byId.get(n.parentId);
  if (!parent || !rendered(parent)) return;
  // A clipping parent is the text-clipped rule's business (and a cover photo
  // cropped by its frame is intended).
  if (clips(parent.overflowX) || clips(parent.overflowY)) return;
  const e = excess(n.box, parent.box);
  const worst = Math.max(e.left, e.right, e.top, e.bottom);
  if (worst <= EPS) return;
  const side = worst === e.bottom ? 'bottom' : worst === e.right ? 'right' : worst === e.top ? 'top' : 'left';
  out.push({
    kind: 'child-overflow',
    severity: 'error',
    nodeId: n.id,
    breakpoint: frame.breakpoint,
    relatedNodeId: parent.id,
    measured: { overflowPx: round(worst), side, childHeight: round(n.box.h), parentHeight: round(parent.box.h) },
    message: `${quote(n)} sticks out ${round(worst)}px past the ${side} edge of its parent ${quote(parent)}: the parent is too small for its content.`,
  });
}

function overlapRule(siblings: MeasuredNode[], frame: FrameMeasurement, out: LayoutFinding[]): void {
  const flow = siblings.filter((s) => rendered(s) && !isIntentionallyLayered(s)).slice(0, MAX_SIBLINGS);
  for (let i = 0; i < flow.length; i++) {
    for (let j = i + 1; j < flow.length; j++) {
      const a = flow[i].box;
      const b = flow[j].box;
      const w = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
      const h = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
      if (w <= EPS || h <= EPS) continue;
      out.push({
        kind: 'overlap',
        severity: 'error',
        nodeId: flow[j].id,
        breakpoint: frame.breakpoint,
        relatedNodeId: flow[i].id,
        measured: { overlapWidth: round(w), overlapHeight: round(h) },
        message: `${quote(flow[j])} overlaps its sibling ${quote(flow[i])} by ${round(w)}x${round(h)}px although neither is layered on purpose.`,
      });
    }
  }
}

function horizontalOverflowRule(
  nodes: MeasuredNode[],
  byId: ReadonlyMap<string, MeasuredNode>,
  frame: FrameMeasurement,
  out: LayoutFinding[],
): void {
  if (!frame.isSmallest) return;
  const outside = (n: MeasuredNode) => rendered(n) && (right(n.box) > frame.width + EPS || n.box.x < -EPS);
  /** Inside an ancestor that clips and itself fits the frame (a deliberate crop or carousel). */
  const containedByClip = (n: MeasuredNode) => {
    let cur = n.parentId ? byId.get(n.parentId) : undefined;
    let guard = 0;
    while (cur && guard++ < 200) {
      if (clips(cur.overflowX) && !outside(cur)) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };
  let reported = 0;
  for (const n of nodes) {
    if (!outside(n) || containedByClip(n)) continue;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent && outside(parent)) continue; // report the outermost only
    reported++;
    const reach = Math.max(right(n.box) - frame.width, -n.box.x);
    out.push({
      kind: 'horizontal-overflow',
      severity: 'error',
      nodeId: n.id,
      breakpoint: frame.breakpoint,
      measured: { frameWidth: round(frame.width), nodeLeft: round(n.box.x), nodeRight: round(right(n.box)), outsidePx: round(reach) },
      message: `On the ${frame.width}px ${frame.breakpoint} frame, ${quote(n)} reaches ${round(reach)}px outside the screen: the page would scroll sideways.`,
    });
  }
  if (reported === 0 && frame.contentScrollWidth > frame.width + EPS) {
    const root = nodes.find((n) => !n.parentId);
    if (root) {
      out.push({
        kind: 'horizontal-overflow',
        severity: 'error',
        nodeId: root.id,
        breakpoint: frame.breakpoint,
        measured: { frameWidth: round(frame.width), contentWidth: round(frame.contentScrollWidth) },
        message: `On the ${frame.width}px ${frame.breakpoint} frame the page content is ${round(frame.contentScrollWidth)}px wide: something reaches outside the screen.`,
      });
    }
  }
}

function headlineRules(n: MeasuredNode, frame: FrameMeasurement, out: LayoutFinding[]): void {
  const lines = n.text?.wordsPerLine;
  if (!n.text || !lines || lines.length === 0 || n.text.fontSizePx < DISPLAY_FONT_PX) return;
  const maxLines = frame.width >= 768 ? 3 : 4;
  const words = lines.reduce((s, w) => s + w, 0);
  if (lines.length > maxLines) {
    out.push({
      kind: 'headline-lines',
      severity: 'warning',
      nodeId: n.id,
      breakpoint: frame.breakpoint,
      measured: { lines: lines.length, maxLines, fontSizePx: round(n.text.fontSizePx), boxWidth: round(n.box.w) },
      message: `Headline ${quote(n)} wraps onto ${lines.length} lines at ${round(n.text.fontSizePx)}px on ${frame.breakpoint} (at most ${maxLines} read well): smaller type, a wider box or shorter copy.`,
    });
  }
  if (lines.length >= 2 && lines[lines.length - 1] === 1 && words >= 3) {
    out.push({
      kind: 'orphan',
      severity: 'warning',
      nodeId: n.id,
      breakpoint: frame.breakpoint,
      measured: { lines: lines.length, lastLineWords: 1 },
      message: `Headline ${quote(n)} ends with a single word alone on its last line on ${frame.breakpoint}.`,
    });
  }
}

function contrastRule(
  n: MeasuredNode,
  byId: ReadonlyMap<string, MeasuredNode>,
  frame: FrameMeasurement,
  out: LayoutFinding[],
): void {
  if (!n.text || !n.text.content.trim()) return;
  const text = parseColor(n.color);
  if (!text || text.a === 0) return;
  const bg = estimateBackground(n, byId, text);
  const ratio = contrastRatio(composite(text, bg.color), bg.color);
  const large = isLargeText(n.text.fontSizePx, n.text.fontWeight);
  const required = large ? 3 : 4.5;
  if (ratio >= required) return;
  const measured = { ratio: Math.round(ratio * 100) / 100, required, fontSizePx: round(n.text.fontSizePx) };
  if (bg.overPhoto) {
    out.push({
      kind: 'image-text-contrast',
      severity: bg.scrim ? 'warning' : 'error',
      nodeId: n.id,
      breakpoint: frame.breakpoint,
      ...(bg.fromId ? { relatedNodeId: bg.fromId } : {}),
      measured: { ...measured, scrim: bg.scrim ? 'yes' : 'none' },
      message: bg.scrim
        ? `Text ${quote(n)} sits on a photo whose scrim is too weak: estimated contrast ${measured.ratio}:1, needs ${required}:1 (a stronger scrim, or text in a solid panel).`
        : `Text ${quote(n)} sits directly on a photo without a scrim: unreadable over a busy picture (estimated ${measured.ratio}:1, needs ${required}:1).`,
    });
    return;
  }
  out.push({
    kind: 'low-contrast',
    severity: 'error',
    nodeId: n.id,
    breakpoint: frame.breakpoint,
    ...(bg.fromId ? { relatedNodeId: bg.fromId } : {}),
    measured,
    message: `Text ${quote(n)} has a contrast of ${measured.ratio}:1 against its background; WCAG AA needs ${required}:1.`,
  });
}

/** Every finding for one frame, errors first. Pure. */
export function classifyFrame(frame: FrameMeasurement): LayoutFinding[] {
  const out: LayoutFinding[] = [];
  const byId = new Map(frame.nodes.map((n) => [n.id, n] as const));
  const children = new Map<string, MeasuredNode[]>();
  for (const n of frame.nodes) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  for (const n of frame.nodes) {
    if (!rendered(n)) continue;
    textBoxRules(n, frame, out);
    ancestorClipRule(n, byId, frame, out);
    childOverflowRule(n, byId, frame, out);
    headlineRules(n, frame, out);
    contrastRule(n, byId, frame, out);
  }
  for (const siblings of children.values()) overlapRule(siblings, frame, out);
  horizontalOverflowRule(frame.nodes, byId, frame, out);
  return sortFindings(out);
}

const KIND_ORDER: FindingKind[] = [
  'text-clipped',
  'horizontal-overflow',
  'overlap',
  'child-overflow',
  'text-overflow',
  'low-contrast',
  'image-text-contrast',
  'headline-lines',
  'orphan',
];

/** Errors first, then by kind (worst first); one finding per kind, node, related node and breakpoint. */
export function sortFindings(findings: LayoutFinding[]): LayoutFinding[] {
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.kind}|${f.nodeId}|${f.relatedNodeId ?? ''}|${f.breakpoint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

/** The findings of several frames, merged, sorted and capped. */
export function auditFrames(frames: FrameMeasurement[], max: number): LayoutFinding[] {
  return sortFindings(frames.flatMap(classifyFrame)).slice(0, max);
}
