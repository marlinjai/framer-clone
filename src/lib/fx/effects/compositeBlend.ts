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
 * screen, overlay or multiply: they ignore it, and so does the group now, in every frame.
 *
 * RENDER-FREE: three.js types only, no React.
 */

import { CustomBlending, DstColorFactor, type Material, type ShaderMaterial } from "three";

/** `uMode` of the composite shader: how a pixel with no alpha must behave under the blend. */
export const COMPOSITE_MODE = { alpha: 0, ignoresAlpha: 1, multiply: 2 } as const;

/**
 * Copy `from`'s blend state onto `to` and return the shader mode that goes with it:
 * normal and add weigh the colour by alpha in the blend state itself, screen and
 * overlay (custom blending) do not, multiply is drawn from premultiplied colour (the quad
 * premultiplies after the colour space conversion, as the layer's own shader does).
 */
export function copyBlendState(from: Material, to: ShaderMaterial): number {
  // Assumes what every content layer's material is: `transparent`, so three.js draws it with the blend
  // function it names (it only drops blending for NormalBlending on a material that is not transparent;
  // a test reads the layer sources to keep that true). The quad is always transparent too.
  const blending = from.blending;
  to.blending = blending;
  to.blendEquation = from.blendEquation;
  to.blendSrc = from.blendSrc;
  to.blendDst = from.blendDst;
  to.blendEquationAlpha = from.blendEquationAlpha;
  to.blendSrcAlpha = from.blendSrcAlpha;
  to.blendDstAlpha = from.blendDstAlpha;
  to.blendColor.copy(from.blendColor);
  to.blendAlpha = from.blendAlpha;
  // No `needsUpdate`: this only selects blend factors when drawing; the quad's shader has no premultiplied chunk to recompile.
  to.premultipliedAlpha = from.premultipliedAlpha;
  if (blending !== CustomBlending) return COMPOSITE_MODE.alpha;
  // The layers' multiply is custom blending with the destination colour as the source factor.
  return from.blendSrc === DstColorFactor ? COMPOSITE_MODE.multiply : COMPOSITE_MODE.ignoresAlpha;
}
