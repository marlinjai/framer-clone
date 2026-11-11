"use client";

/**
 * Content-layer blend mapping (spec section 3 "Blend modes").
 *
 * Three.js fixed-function blending covers `normal` (NormalBlending),
 * `add` (AdditiveBlending), and `multiply` (MultiplyBlending) directly.
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
  type Material,
  MultiplyBlending,
  NormalBlending,
  OneFactor,
  OneMinusDstColorFactor,
  OneMinusSrcColorFactor,
} from "three";

import type { BlendMode } from "../types";

export function applyContentBlend(material: Material, mode: BlendMode): void {
  switch (mode) {
    case "normal":
      material.blending = NormalBlending;
      return;
    case "add":
      material.blending = AdditiveBlending;
      return;
    case "multiply":
      material.blending = MultiplyBlending;
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
