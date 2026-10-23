// src/lib/canvas/spacingGeometry.ts
//
// Pure geometry for the on-canvas spacing handles (SpacingHandlesLayer):
// where the padding, margin and gap bands of the selected element sit on
// screen, and where each band's drag handle goes. Inputs are plain numbers
// and rects (screen px for rects, CSS px for spacing values, plus the screen
// scale of the element), never DOM, so every case is unit tested.
//
// Coordinates: rects are screen rects (getBoundingClientRect space). Spacing
// values are CSS px as getComputedStyle reports them, which the camera's
// scale() does not change; `scale` turns them into screen px.
import type { ScreenRect } from './viewportFrame';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type BoxKind = 'padding' | 'margin';
/**
 * Which gap a band shows: `column` is the space between items placed side by
 * side (CSS column-gap), `row` the space between items stacked vertically
 * (CSS row-gap).
 */
export type GapAxis = 'row' | 'column';

export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type SpacingTarget =
  | { kind: BoxKind; side: Side }
  | { kind: 'gap'; axis: GapAxis };

export interface SpacingRegion {
  /** Stable for the same element and layout: `padding-top`, `gap-column-0`. */
  id: string;
  target: SpacingTarget;
  /** The band on screen. May be zero thick (a 0px padding still gets a handle). */
  rect: ScreenRect;
  /** The current value in CSS px. */
  value: number;
}

export interface HandlePlacement {
  /** The grabbable area on screen (larger than the drawn bar). */
  hit: ScreenRect;
  /** The drawn bar on screen, centred in `hit`. */
  bar: ScreenRect;
  /** Bar direction: a horizontal bar is dragged up and down. */
  orientation: 'horizontal' | 'vertical';
}

export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

/** Drawn bar size in screen px; constant at every zoom. */
export const HANDLE_LENGTH = 16;
export const HANDLE_THICKNESS = 4;
/** Extra grabbable margin around the bar on every side. */
export const HANDLE_HIT_PAD = 4;
/**
 * Least distance from the element's edge to a handle's centre. A handle in a
 * thin band would sit on HudSurface's mid-edge resize dot (it spans 6px out
 * and 2px in from the edge), so a thin band's handle moves out of the band:
 * inward for padding, outward for margin. 12px keeps the hit areas apart.
 */
export const HANDLE_MIN_OFFSET = 12;
/** A band shorter than this along its length gets no handle (no room for one). */
export const HANDLE_MIN_LENGTH = HANDLE_LENGTH + 2 * HANDLE_HIT_PAD;
/**
 * A padding handle pushed inward by HANDLE_MIN_OFFSET needs room for the
 * opposite side's handle too; below this element size (across the band) the
 * pushed-in handles would overlap, so they are hidden. A band thick enough to
 * hold its own handle is never hidden by this rule.
 */
export const PADDING_HANDLE_MIN_ELEMENT = 2 * (HANDLE_MIN_OFFSET + HANDLE_HIT_PAD + HANDLE_THICKNESS / 2) + 8;

const EPS = 0.5;

const right = (r: ScreenRect) => r.left + r.width;
const bottom = (r: ScreenRect) => r.top + r.height;
const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * The element's content box on screen: its border box minus border and
 * padding. Widths never go negative (an element smaller than its padding).
 */
export function contentBox(rect: ScreenRect, border: Edges, padding: Edges, scale: number): ScreenRect {
  const left = rect.left + (nonNeg(border.left) + nonNeg(padding.left)) * scale;
  const top = rect.top + (nonNeg(border.top) + nonNeg(padding.top)) * scale;
  const r = right(rect) - (nonNeg(border.right) + nonNeg(padding.right)) * scale;
  const b = bottom(rect) - (nonNeg(border.bottom) + nonNeg(padding.bottom)) * scale;
  return { left, top, width: Math.max(0, r - left), height: Math.max(0, b - top) };
}

/**
 * Padding bands (inside the border) and, when `includeMargin`, margin bands
 * (outside the border box) of one element. Top and bottom bands span the full
 * width; left and right bands fill the height between them, so no two bands
 * overlap. A negative margin draws as a zero-thick band.
 */
export function boxBands(input: {
  rect: ScreenRect;
  border: Edges;
  padding: Edges;
  margin: Edges;
  scale: number;
  includeMargin: boolean;
}): SpacingRegion[] {
  const { rect, border, padding, margin, scale, includeMargin } = input;
  const out: SpacingRegion[] = [];

  const innerLeft = rect.left + nonNeg(border.left) * scale;
  const innerRight = right(rect) - nonNeg(border.right) * scale;
  const innerTop = rect.top + nonNeg(border.top) * scale;
  const innerBottom = bottom(rect) - nonNeg(border.bottom) * scale;
  const innerWidth = Math.max(0, innerRight - innerLeft);
  const pt = nonNeg(padding.top) * scale;
  const pr = nonNeg(padding.right) * scale;
  const pb = nonNeg(padding.bottom) * scale;
  const pl = nonNeg(padding.left) * scale;
  const middleTop = innerTop + pt;
  const middleHeight = Math.max(0, innerBottom - pb - middleTop);

  out.push(
    { id: 'padding-top', target: { kind: 'padding', side: 'top' }, value: padding.top,
      rect: { left: innerLeft, top: innerTop, width: innerWidth, height: pt } },
    { id: 'padding-right', target: { kind: 'padding', side: 'right' }, value: padding.right,
      rect: { left: innerRight - pr, top: middleTop, width: pr, height: middleHeight } },
    { id: 'padding-bottom', target: { kind: 'padding', side: 'bottom' }, value: padding.bottom,
      rect: { left: innerLeft, top: innerBottom - pb, width: innerWidth, height: pb } },
    { id: 'padding-left', target: { kind: 'padding', side: 'left' }, value: padding.left,
      rect: { left: innerLeft, top: middleTop, width: pl, height: middleHeight } },
  );

  if (includeMargin) {
    const mt = nonNeg(margin.top) * scale;
    const mr = nonNeg(margin.right) * scale;
    const mb = nonNeg(margin.bottom) * scale;
    const ml = nonNeg(margin.left) * scale;
    out.push(
      { id: 'margin-top', target: { kind: 'margin', side: 'top' }, value: margin.top,
        rect: { left: rect.left, top: rect.top - mt, width: rect.width, height: mt } },
      { id: 'margin-right', target: { kind: 'margin', side: 'right' }, value: margin.right,
        rect: { left: right(rect), top: rect.top, width: mr, height: rect.height } },
      { id: 'margin-bottom', target: { kind: 'margin', side: 'bottom' }, value: margin.bottom,
        rect: { left: rect.left, top: bottom(rect), width: rect.width, height: mb } },
      { id: 'margin-left', target: { kind: 'margin', side: 'left' }, value: margin.left,
        rect: { left: rect.left - ml, top: rect.top, width: ml, height: rect.height } },
    );
  }
  return out;
}

interface Line {
  items: ScreenRect[];
  crossStart: number;
  crossEnd: number;
}

/**
 * Gap bands of a flex or grid container, from its children's screen rects.
 *
 * `flow` is the main axis: `row` for flex-direction row (and grid with row
 * auto-flow), `column` for flex-direction column. Items are grouped into
 * lines along the cross axis (one line when `wrap` is false, as for a nowrap
 * flex container, whose items need not overlap to share the line). Between
 * neighbours in a line sits a main-axis gap band; between lines a cross-axis
 * band spanning the content box. Each band is exactly the gap value thick,
 * centred in the free space between the two items, so justify-content's extra
 * space is not mistaken for gap. Grid column bands that line up across rows
 * are merged into one stripe. Order (reverse directions, grid placement) comes
 * from the rects, not the DOM.
 */
export function gapBands(input: {
  content: ScreenRect;
  children: ScreenRect[];
  flow: 'row' | 'column';
  wrap: boolean;
  rowGap: number;
  columnGap: number;
  scale: number;
}): SpacingRegion[] {
  const { content, flow, wrap, scale } = input;
  const items = input.children.filter(r => r.width > 0 || r.height > 0);
  if (items.length < 2) return [];

  const isRow = flow === 'row';
  const mainStart = (r: ScreenRect) => (isRow ? r.left : r.top);
  const mainEnd = (r: ScreenRect) => (isRow ? right(r) : bottom(r));
  const crossStart = (r: ScreenRect) => (isRow ? r.top : r.left);
  const crossEnd = (r: ScreenRect) => (isRow ? bottom(r) : right(r));
  const mainAxis: GapAxis = isRow ? 'column' : 'row';
  const crossAxis: GapAxis = isRow ? 'row' : 'column';
  const mainGap = nonNeg(isRow ? input.columnGap : input.rowGap);
  const crossGap = nonNeg(isRow ? input.rowGap : input.columnGap);
  const contentMainStart = mainStart(content);
  const contentMainEnd = mainEnd(content);

  // Screen rect from main/cross extents.
  const toRect = (m0: number, m1: number, c0: number, c1: number): ScreenRect =>
    isRow
      ? { left: m0, top: c0, width: Math.max(0, m1 - m0), height: Math.max(0, c1 - c0) }
      : { left: c0, top: m0, width: Math.max(0, c1 - c0), height: Math.max(0, m1 - m0) };

  // Group into lines along the cross axis.
  const lines: Line[] = [];
  if (!wrap) {
    lines.push({
      items: items.slice(),
      crossStart: Math.min(...items.map(crossStart)),
      crossEnd: Math.max(...items.map(crossEnd)),
    });
  } else {
    const sorted = items.slice().sort((a, b) => crossStart(a) - crossStart(b) || mainStart(a) - mainStart(b));
    for (const item of sorted) {
      const line = lines[lines.length - 1];
      if (line && crossStart(item) < line.crossEnd - EPS) {
        line.items.push(item);
        line.crossEnd = Math.max(line.crossEnd, crossEnd(item));
      } else {
        lines.push({ items: [item], crossStart: crossStart(item), crossEnd: crossEnd(item) });
      }
    }
  }

  // Main-axis gaps within each line. A single line spans the content box
  // across; several lines span their own extent.
  const singleLine = lines.length === 1;
  const mainBands: { m0: number; m1: number; c0: number; c1: number }[] = [];
  for (const line of lines) {
    const inLine = line.items.slice().sort((a, b) => mainStart(a) - mainStart(b));
    const c0 = singleLine ? crossStart(content) : line.crossStart;
    const c1 = singleLine ? crossEnd(content) : line.crossEnd;
    for (let i = 1; i < inLine.length; i++) {
      const space = mainStart(inLine[i]) - mainEnd(inLine[i - 1]);
      if (space < -EPS) continue; // overlapping items: no gap to show
      const free = Math.max(0, space);
      const thick = Math.min(mainGap * scale, free);
      const m0 = mainEnd(inLine[i - 1]) + (free - thick) / 2;
      mainBands.push({ m0, m1: m0 + thick, c0, c1 });
    }
  }

  // Merge bands that line up across consecutive lines (grid columns).
  const merged: typeof mainBands = [];
  for (const band of mainBands.slice().sort((a, b) => a.m0 - b.m0 || a.c0 - b.c0)) {
    const prev = merged.find(m =>
      Math.abs(m.m0 - band.m0) < EPS && Math.abs(m.m1 - band.m1) < EPS && band.c0 >= m.c0 - EPS);
    if (prev && !singleLine) {
      prev.c0 = Math.min(prev.c0, band.c0);
      prev.c1 = Math.max(prev.c1, band.c1);
    } else {
      merged.push({ ...band });
    }
  }

  const out: SpacingRegion[] = merged.map((b, i) => ({
    id: `gap-${mainAxis}-${i}`,
    target: { kind: 'gap', axis: mainAxis },
    value: isRow ? input.columnGap : input.rowGap,
    rect: toRect(b.m0, b.m1, b.c0, b.c1),
  }));

  // Cross-axis gaps between lines, across the whole content box.
  for (let i = 1; i < lines.length; i++) {
    const space = lines[i].crossStart - lines[i - 1].crossEnd;
    if (space < -EPS) continue;
    const free = Math.max(0, space);
    const thick = Math.min(crossGap * scale, free);
    const c0 = lines[i - 1].crossEnd + (free - thick) / 2;
    out.push({
      id: `gap-${crossAxis}-${i - 1}`,
      target: { kind: 'gap', axis: crossAxis },
      value: isRow ? input.rowGap : input.columnGap,
      rect: toRect(contentMainStart, contentMainEnd, c0, c0 + thick),
    });
  }
  return out;
}

/**
 * Where a band's handle goes, or null when it gets none.
 *
 * The handle is a short bar centred along the band. Across the band it sits
 * in the band's middle, but never closer than HANDLE_MIN_OFFSET to the
 * element's edge: a thin padding band's handle moves inward, a thin margin
 * band's handle outward, so a 0px side is still grabbable and never covers a
 * resize dot. Gap handles sit in the middle of the gap. `element` is the
 * element's border box on screen.
 */
export function handleForRegion(region: SpacingRegion, element: ScreenRect): HandlePlacement | null {
  const { rect, target } = region;
  let orientation: 'horizontal' | 'vertical';
  let cx: number;
  let cy: number;

  if (target.kind === 'gap') {
    orientation = target.axis === 'column' ? 'vertical' : 'horizontal';
    const length = orientation === 'vertical' ? rect.height : rect.width;
    if (length < HANDLE_MIN_LENGTH) return null;
    cx = rect.left + rect.width / 2;
    cy = rect.top + rect.height / 2;
  } else {
    const { side, kind } = target;
    const horizontal = side === 'top' || side === 'bottom';
    orientation = horizontal ? 'horizontal' : 'vertical';
    const length = horizontal ? rect.width : rect.height;
    if (length < HANDLE_MIN_LENGTH) return null;
    const thickness = horizontal ? rect.height : rect.width;
    const offset = Math.max(thickness / 2, HANDLE_MIN_OFFSET);
    if (kind === 'padding' && thickness / 2 < HANDLE_MIN_OFFSET) {
      const across = horizontal ? element.height : element.width;
      if (across < PADDING_HANDLE_MIN_ELEMENT) return null;
    }
    // The edge the band starts from (the element side) and the direction
    // pointing away from it into the band.
    const inward = kind === 'padding';
    if (horizontal) {
      cx = rect.left + rect.width / 2;
      if (side === 'top') cy = inward ? rect.top + offset : bottom(rect) - offset;
      else cy = inward ? bottom(rect) - offset : rect.top + offset;
    } else {
      cy = rect.top + rect.height / 2;
      if (side === 'left') cx = inward ? rect.left + offset : right(rect) - offset;
      else cx = inward ? right(rect) - offset : rect.left + offset;
    }
  }

  const barW = orientation === 'horizontal' ? HANDLE_LENGTH : HANDLE_THICKNESS;
  const barH = orientation === 'horizontal' ? HANDLE_THICKNESS : HANDLE_LENGTH;
  const bar = { left: cx - barW / 2, top: cy - barH / 2, width: barW, height: barH };
  const hit = {
    left: bar.left - HANDLE_HIT_PAD,
    top: bar.top - HANDLE_HIT_PAD,
    width: barW + 2 * HANDLE_HIT_PAD,
    height: barH + 2 * HANDLE_HIT_PAD,
  };
  return { hit, bar, orientation };
}

/** True when the point lies inside the rect, grown by `slop` on every side. */
export function rectContains(rect: ScreenRect, x: number, y: number, slop = 0): boolean {
  return x >= rect.left - slop && x <= right(rect) + slop && y >= rect.top - slop && y <= bottom(rect) + slop;
}

/** The element's margin box on screen (negative margins count as 0). */
export function outerBox(rect: ScreenRect, margin: Edges, scale: number): ScreenRect {
  const left = rect.left - nonNeg(margin.left) * scale;
  const top = rect.top - nonNeg(margin.top) * scale;
  return {
    left,
    top,
    width: right(rect) + nonNeg(margin.right) * scale - left,
    height: bottom(rect) + nonNeg(margin.bottom) * scale - top,
  };
}

/** Intersection of two rects, or null when they do not overlap. */
export function intersectRects(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const r = Math.min(right(a), right(b));
  const btm = Math.min(bottom(a), bottom(b));
  if (r <= left || btm <= top) return null;
  return { left, top, width: r - left, height: btm - top };
}
