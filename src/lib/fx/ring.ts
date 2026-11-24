/**
 * The particle ring's render-free entry: the ring core (the seeded particles and the two shaders) and the live
 * canvas's pixel ratio rule, for the published page's first still of a ring (src/lib/fxScene/ringStill.ts), which
 * draws that one frame with plain WebGL before the engine is there.
 *
 * Its own entry because the island that draws the still is part of every published page's code (a client
 * component lands in its route's chunk, on pages with a scene or not): it must carry these two small files and
 * nothing else, not the scene format, the layer schemas or the presets that `./format` brings
 * (src/lib/fx/__tests__/importGraph.test.ts pins exactly these files).
 *
 * RENDER-FREE: no React, no three.js.
 */

export {
  RING_FRAGMENT,
  RING_START_TIME,
  RING_VERTEX,
  buildRingParticles,
  mulberry32,
  ringGlowPasses,
  ringRadius,
} from "./particleRingCore";
export { FX_TOUCH_QUERY, canvasPixelRatio, isTouchLikely, liveDprRange } from "./pixelRatio";
