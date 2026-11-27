/**
 * The pixel ratio a live scene's canvas is drawn at, written once for the engine (./LumitraScene) and for the
 * published page's first still of a particle ring (src/lib/fxScene/ringStill.ts), so the still and the first
 * live frame have the same pixels and the same point sizes (the ring's points are sized in device pixels).
 *
 * RENDER-FREE: no React, no three.js. Safe without a window (the server): a ratio of 1, not a touch device.
 */

/** Coarse-pointer (touch) devices start at a ratio of 1 before any frame rate is measured: the same query Tailwind and drei use. */
export const FX_TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

export function isTouchLikely(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(FX_TOUCH_QUERY).matches;
}

/**
 * The ratio a canvas with the range `[min, max]` is drawn at, as react-three-fiber computes it from its `dpr`
 * prop: the device's ratio, kept inside the range.
 */
export function canvasPixelRatio([min, max]: readonly [number, number], deviceRatio: number): number {
  return Math.min(Math.max(min, deviceRatio), max);
}

/**
 * The range a live scene draws with: the stored one, or `[1, 1]` once it has stepped down. A touch device
 * starts stepped down (`isTouchLikely`); elsewhere the frame rate decides later (./frameRate).
 */
export function liveDprRange(stored: readonly [number, number], steppedDown: boolean): [number, number] {
  return steppedDown ? [1, 1] : [stored[0], stored[1]];
}
