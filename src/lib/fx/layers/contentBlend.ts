"use client";

/**
 * Content-layer blend mapping (spec section 3 "Blend modes").
 *
 * Three.js fixed-function blending covers `normal` (NormalBlending) and
 * `add` (AdditiveBlending) directly.
 *
 * `screen` we wire as CustomBlending with the textbook screen equation:
 *
 *     dst' = src + dst * (1 - src)
 *
 * which falls out of `srcRGB = ONE`, `dstRGB = ONE_MINUS_SRC_COLOR`, ADD.
 * Same equation for alpha so masked content layers don't ghost.
 *
 * `overlay` cannot be expressed in fixed-function blending because the
 * per-channel branch depends on the destination color, which requires reading
 * back the framebuffer. Implementing a real overlay would mean a per-content-
 * layer copy pass — overkill for a hero scene where overlay is a "look",
 * not a math contract. We approximate overlay with a screen-style equation
 * boosted toward the source color (`srcRGB = ONE_MINUS_DST_COLOR`, ADD),
 * which gives the visually-similar "punches highlights, leaves shadows"
 * feel without the framebuffer-read cost. A real overlay arrives in Phase 3
 * if the difference shows up in a real scene.
 *
 * The output is a small descriptor `applyContentBlend` mutates onto the
 * material; that keeps the host components free of three-import noise for
 * the simple blend cases.
 */

import {
  AdditiveBlending,
  AddEquation,
  CustomBlending,
  DstColorFactor,
  type Material,
  NormalBlending,
  type ShaderMaterial,
  OneFactor,
  OneMinusDstColorFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  ZeroFactor,
} from "three";

import type { BlendMode } from "../types";

/** True for the blend state `applyContentBlend` gives multiply: custom blending with the destination colour as the source factor. */
export function isMultiplyBlend(material: Material): boolean {
  return material.blending === CustomBlending && material.blendSrc === DstColorFactor;
}

export function applyContentBlend(material: Material, mode: BlendMode): void {
  // Multiply is drawn from premultiplied colour (see the case below), every other mode from plain
  // colour: the layers' shaders multiply their colour by their alpha when this uniform is 1.
  const premultiply = (material as Partial<ShaderMaterial>).uniforms?.uPremultiply;
  if (premultiply) premultiply.value = mode === "multiply" ? 1 : 0;
  else if (mode === "multiply") {
    // Without the uniform the colour would stay plain and multiply would brighten the pixels the layer
    // does not cover. Every content layer with a blend has it; a new one must too. Said, and drawn normally.
    console.error("[lumitra-fx] multiply needs a material with the uPremultiply uniform; drawing normally instead.");
    material.blending = NormalBlending;
    return;
  }
  switch (mode) {
    case "normal":
      material.blending = NormalBlending;
      return;
    case "add":
      material.blending = AdditiveBlending;
      return;
    case "multiply":
      // Colour = destination x source, and a pixel the layer does not cover leaves the destination
      // alone. With the source premultiplied (the layers' shaders multiply their colour by their alpha
      // when their `uPremultiply` uniform is 1, set above):
      //   out = src * dst + dst * (1 - srcAlpha) = dst * (1 - a + a * colour)
      // which is the colour mixed toward white by the alpha, times the destination. Written as custom
      // blending because three.js 0.184 refuses `MultiplyBlending` unless the material is premultiplied
      // and then draws with whatever function was set before it.
      material.blending = CustomBlending;
      material.blendEquation = AddEquation;
      material.blendSrc = DstColorFactor;
      material.blendDst = OneMinusSrcAlphaFactor;
      material.blendEquationAlpha = AddEquation;
      material.blendSrcAlpha = ZeroFactor;
      material.blendDstAlpha = OneFactor; // the destination's alpha stays
      return;
    case "screen":
      material.blending = CustomBlending;
      material.blendEquation = AddEquation;
      material.blendSrc = OneFactor;
      material.blendDst = OneMinusSrcColorFactor;
      material.blendEquationAlpha = AddEquation;
      material.blendSrcAlpha = OneFactor;
      material.blendDstAlpha = OneMinusSrcColorFactor;
      return;
    case "overlay":
      // See module doc: this is a screen-leaning approximation, not a real
      // overlay. Documented compromise to avoid a per-layer FBO copy.
      material.blending = CustomBlending;
      material.blendEquation = AddEquation;
      material.blendSrc = OneMinusDstColorFactor;
      material.blendDst = OneFactor;
      material.blendEquationAlpha = AddEquation;
      material.blendSrcAlpha = OneFactor;
      material.blendDstAlpha = OneMinusSrcColorFactor;
      return;
  }
}
