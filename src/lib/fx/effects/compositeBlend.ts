/**
 * The blend a group's composite quad draws with: the one its target layer draws with itself.
 *
 * Not `layer.blend`: a content layer applies its blend mode to its own material (noiseFill,
 * gradient, image, shape do; the text lockup draws normally whatever the stored value says).
 * A group that applied the stored value to every target would draw a text layer set to `add`
 * with an add blend that the same layer, unscoped, never has.
 *
 * Copied from the live material in the frame that draws the quad, so the quad can never be
 * a frame behind the layer (a blend applied from an effect, after the first frame, was).
 *
 * RENDER-FREE: three.js types only, no React.
 */

import { CustomBlending, MultiplyBlending, type Material, type ShaderMaterial } from "three";

/** `uMode` of the composite shader: how a pixel with no alpha must behave under the blend. */
export const COMPOSITE_MODE = { alpha: 0, ignoresAlpha: 1, multiply: 2 } as const;

/**
 * Copy `from`'s blend state onto `to` and return the shader mode that goes with it:
 * normal and add weigh the colour by alpha in the blend state itself, screen and
 * overlay (custom blending) do not, multiply leaves the picture alone where nothing is drawn.
 */
export function copyBlendState(from: Material, to: ShaderMaterial): number {
  to.blending = from.blending;
  to.blendEquation = from.blendEquation;
  to.blendSrc = from.blendSrc;
  to.blendDst = from.blendDst;
  to.blendEquationAlpha = from.blendEquationAlpha;
  to.blendSrcAlpha = from.blendSrcAlpha;
  to.blendDstAlpha = from.blendDstAlpha;
  if (from.blending === MultiplyBlending) return COMPOSITE_MODE.multiply;
  return from.blending === CustomBlending ? COMPOSITE_MODE.ignoresAlpha : COMPOSITE_MODE.alpha;
}
