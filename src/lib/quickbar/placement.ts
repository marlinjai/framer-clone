// src/lib/quickbar/placement.ts
//
// Where the phone editor's floating quick toolbar and long-press menu sit
// (plan docs/plans/2026-10-24-editor-on-phones.md, section "Quick toolbar").
// Pure math on screen rectangles, so the rules are unit tested:
//
//   - The toolbar sits above the selected element, centred on it, with a gap.
//   - When there is no room above (under the top bar), it goes below.
//   - It never covers the element. When there is room neither above nor below
//     (an element taller than the visible area, a full-height section), it
//     docks at the bottom of the visible area, just above the bottom bar and
//     the keyboard: covering part of a tall element is unavoidable there, and
//     the bottom edge is where the eye expects controls.
//   - It is always clamped inside the visible area: between the top bar and
//     the bottom bar (or the on-screen keyboard, whichever is higher), and
//     within the side margins.

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The part of the screen the toolbar may use. */
export interface VisibleArea {
  /** Screen width. */
  width: number;
  /** Bottom of the top bar (the first usable y). */
  top: number;
  /** First y that is covered at the bottom: the bottom bar's top, or the keyboard's, whichever is higher. */
  bottom: number;
}

export type Placement = 'above' | 'below' | 'docked';

export interface PlacementResult {
  left: number;
  top: number;
  placement: Placement;
}

/** Space between the element and the toolbar. */
export const QUICKBAR_GAP = 10;
/** Window event the quick toolbar dispatches when it moves, shows or hides. */
export const QUICKBAR_MOVED_EVENT = 'quickbar:moved';
/** The quick toolbar's root (its data-testid); `data-shown="true"` while visible. */
export const QUICKBAR_SELECTOR = '[data-testid="quick-toolbar"][data-shown="true"]';
/** Space kept from the screen edges and the bars. */
export const QUICKBAR_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * The bottom limit given the bottom bar's top and the keyboard inset: the
 * keyboard covers `keyboardInset` px from the bottom of the layout viewport.
 */
export function visibleBottom(screenHeight: number, bottomBarTop: number, keyboardInset: number): number {
  const keyboardTop = screenHeight - Math.max(0, keyboardInset);
  return Math.min(bottomBarTop, keyboardTop);
}

/** Place a toolbar of `bar` size next to `target` inside `area`. */
export function placeQuickbar(
  target: ScreenRect,
  bar: Size,
  area: VisibleArea,
  gap = QUICKBAR_GAP,
  margin = QUICKBAR_MARGIN,
): PlacementResult {
  const minTop = area.top + margin;
  const maxTop = area.bottom - margin - bar.height;
  const centreX = target.left + target.width / 2;
  const left = clamp(centreX - bar.width / 2, margin, area.width - margin - bar.width);

  const aboveTop = target.top - gap - bar.height;
  if (aboveTop >= minTop && aboveTop <= maxTop) return { left, top: aboveTop, placement: 'above' };

  const belowTop = target.top + target.height + gap;
  if (belowTop >= minTop && belowTop <= maxTop) return { left, top: belowTop, placement: 'below' };

  return { left, top: clamp(maxTop, minTop, maxTop), placement: 'docked' };
}

/**
 * How far to pan the canvas vertically (screen px, positive moves the content
 * down) so `target` shows between `top` and `bottom`: the properties sheet at
 * peek covers the lower part of the screen, and the edited element must stay
 * visible above it. Zero when it already fits. An element that fits is
 * centred in the free band; a taller one is aligned with the band's top.
 */
export function panDeltaIntoView(target: ScreenRect, top: number, bottom: number, margin = QUICKBAR_MARGIN): number {
  const bandTop = top + margin;
  const bandBottom = bottom - margin;
  const band = bandBottom - bandTop;
  if (band <= 0) return 0;
  if (target.top >= bandTop && target.top + target.height <= bandBottom) return 0;
  const desiredTop = target.height <= band ? bandTop + (band - target.height) / 2 : bandTop;
  return Math.round(desiredTop - target.top);
}

/**
 * Place a menu (the long-press context menu) next to a finger point: to the
 * right of and below the finger by default, flipped left or up when it would
 * leave the visible area, then clamped inside it.
 */
export function placeMenuAtPoint(
  point: { x: number; y: number },
  menu: Size,
  area: VisibleArea,
  offset = 12,
  margin = QUICKBAR_MARGIN,
): { left: number; top: number } {
  let left = point.x + offset;
  if (left + menu.width > area.width - margin) left = point.x - offset - menu.width;
  let top = point.y + offset;
  if (top + menu.height > area.bottom - margin) top = point.y - offset - menu.height;
  return {
    left: clamp(left, margin, area.width - margin - menu.width),
    top: clamp(top, area.top + margin, area.bottom - margin - menu.height),
  };
}
