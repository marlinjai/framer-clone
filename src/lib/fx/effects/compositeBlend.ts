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
 * Also changes what a scoped text lockup or text box looks like when its stored blend is add,
 * screen or overlay: they ignore it, and so does the group now, in every frame. (Multiply is
 * inert for every layer in three.js 0.184, which refuses it without `premultipliedAlpha`; the
 * copy keeps that equally inert.)
 *
 * RENDER-FREE: three.js types only, no React.
 */

import { CustomBlending, MultiplyBlending, NoBlending, type Material, type ShaderMaterial } from "three";

/** `uMode` of the composite shader: how a pixel with no alpha must behave under the blend. */
export const COMPOSITE_MODE = { alpha: 0, ignoresAlpha: 1, multiply: 2 } as const;

/**
 * Copy `from`'s blend state onto `to` and return the shader mode that goes with it:
 * normal and add weigh the colour by alpha in the blend state itself, screen and
 * overlay (custom blending) do not, multiply leaves the picture alone where nothing is drawn.
 */
export function copyBlendState(from: Material, to: ShaderMaterial): number {
  // three.js draws a material that is not `transparent` without blending, whatever `blending` says.
  const blending = from.transparent ? from.blending : NoBlending;
  to.blending = blending;
  to.blendEquation = from.blendEquation;
  to.blendSrc = from.blendSrc;
  to.blendDst = from.blendDst;
  to.blendEquationAlpha = from.blendEquationAlpha;
  to.blendSrcAlpha = from.blendSrcAlpha;
  to.blendDstAlpha = from.blendDstAlpha;
  to.blendColor.copy(from.blendColor);
  to.blendAlpha = from.blendAlpha;
  to.premultipliedAlpha = from.premultipliedAlpha;
  if (blending === MultiplyBlending) return COMPOSITE_MODE.multiply;
  return blending === CustomBlending ? COMPOSITE_MODE.ignoresAlpha : COMPOSITE_MODE.alpha;
}
