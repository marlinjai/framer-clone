// Pick the breakpoint that matches a given preview width.
//
// Mirrors how Framer's preview behaves: as the user drags the viewport width,
// the renderer re-resolves styles using the largest breakpoint whose minWidth
// is still <= width. If width is below every breakpoint's minWidth (e.g. user
// dragged below the smallest mobile breakpoint), fall back to the smallest one
// so the preview stays defined.

export interface ViewportLike {
  breakpointId?: string;
  breakpointMinWidth?: number;
}

/**
 * Returns the breakpointId for a given preview width, or `undefined` if the
 * input contains no usable viewports. Picking rule:
 *   - Largest minWidth such that minWidth <= width.
 *   - If width is smaller than every minWidth, return the smallest viewport.
 */
export function pickBreakpointForWidth(
  viewports: readonly ViewportLike[],
  width: number,
): string | undefined {
  const usable = viewports.filter(
    (v): v is Required<ViewportLike> =>
      typeof v.breakpointId === 'string' &&
      typeof v.breakpointMinWidth === 'number' &&
      Number.isFinite(v.breakpointMinWidth),
  );
  if (usable.length === 0) return undefined;

  // Sort ascending by minWidth so [0] is the smallest.
  const ascending = [...usable].sort(
    (a, b) => a.breakpointMinWidth - b.breakpointMinWidth,
  );

  let pick = ascending[0];
  for (const v of ascending) {
    if (v.breakpointMinWidth <= width) pick = v;
    else break;
  }
  return pick.breakpointId;
}
