// src/lib/canvas/viewportFrame.ts
// Geometry and styling contract for a breakpoint viewport frame on the editor
// canvas (Desktop, Tablet, Phone).
//
// Framer semantics: a frame's configured height (ComponentModel.viewportHeight)
// is its MINIMUM. The frame grows to fit the page content and shrinks back to
// the minimum when the content gets shorter. Nothing inside a frame scrolls
// (the canvas owns the wheel for panning, so an inner scroller would be
// unreachable) and nothing renders outside it.
//
// Only the editor canvas uses these frames. Preview (PreviewShell) and the
// published site (HeadlessPageRenderer) render the page on their own.
import type { CSSProperties } from 'react';

/** Real height of a frame: at least its minimum, grown to the measured content. */
export function resolveViewportFrameHeight(
  minHeight: number,
  renderedHeight: number | undefined,
): number {
  if (renderedHeight === undefined || !Number.isFinite(renderedHeight)) return minHeight;
  return Math.max(minHeight, Math.round(renderedHeight));
}

/**
 * Text for the frame label. `size` is the real rendered "W×H"; `minNote` names
 * the configured minimum whenever the frame has grown past it, so the label
 * never claims a height the frame does not have.
 */
export function viewportFrameLabel(
  width: number,
  minHeight: number,
  renderedHeight: number | undefined,
): { size: string; minNote: string | null } {
  const height = resolveViewportFrameHeight(minHeight, renderedHeight);
  return {
    size: `${width}×${height}`,
    minNote: height > minHeight ? `min ${minHeight}` : null,
  };
}

/**
 * Style of the clipping box that holds the page tree inside a frame.
 *
 * - No fixed `height`: `minHeight` plus a single grid row sized
 *   `minmax(min, auto)` lets the frame grow with its content.
 * - The grid row gives the page root a definite area to resolve percentage
 *   heights against, so a root with `height: 100%` or `minHeight: 100%` fills
 *   the frame's minimum. A percentage cannot grow the row itself (CSS treats a
 *   cyclic percentage as `auto` while sizing the track), so there is no
 *   measure-and-grow feedback loop.
 * - `alignItems: start` keeps an auto-height root at its content height, as on
 *   the published page, instead of stretching it to the minimum.
 * - `minmax(0, 1fr)` column: wide content cannot widen the frame.
 * - `overflow: hidden` plus `position: relative` and `contain: paint`: the box
 *   is the containing block for absolutely AND fixed positioned descendants
 *   and clips them, so generated content can never paint outside its frame.
 */
export function viewportFrameContentStyle(minHeight: number): CSSProperties {
  return {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gridTemplateRows: `minmax(${minHeight}px, auto)`,
    alignItems: 'start',
    width: '100%',
    minHeight: `${minHeight}px`,
    overflow: 'hidden',
    contain: 'paint',
  };
}

/**
 * Stable string of every frame's rendered height. The HUD uses it as an effect
 * dependency so selection overlays follow frames that grow or shrink with
 * their content (content moving inside a frame usually changes its height).
 */
export function frameHeightsKey(
  viewportNodes: ReadonlyArray<{ id: string; renderedViewportHeight?: number }> | undefined,
): string {
  if (!viewportNodes) return '';
  return viewportNodes.map(v => `${v.id}:${v.renderedViewportHeight ?? ''}`).join('|');
}
