/**
 * Param animation helper.
 *
 * Per spec section 3: `value(t) = base + drift * noise(t * speed + phase)`.
 * v7's hero doesn't use this yet (its motion is bespoke inside each layer),
 * but the seam exists so a later scene can declare e.g.
 *   animate: { exposure: { speed: 0.5, drift: 0.04, phase: 0 } }
 * and have it just work without per-layer code.
 */

import type { AnimateSpec } from "./types";

/**
 * Quick, deterministic 1D value-noise. Not as smooth as simplex but cheap and
 * good enough for low-frequency param drift. Output ~[-1, 1].
 */
function vnoise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin((i + 1) * 12.9898) * 43758.5453;
  const ra = a - Math.floor(a);
  const rb = b - Math.floor(b);
  const u = f * f * (3 - 2 * f);
  return (ra * (1 - u) + rb * u) * 2 - 1;
}

export function resolveAnimatedNumber(
  base: number,
  spec: AnimateSpec | undefined,
  time: number,
): number {
  if (!spec) return base;
  return base + spec.drift * vnoise1(time * spec.speed + spec.phase);
}
