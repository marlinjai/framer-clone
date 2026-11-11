"use client";

/**
 * Film grain post layer (spec section 4.8).
 *
 * Wraps `postprocessing`'s NoiseEffect. Output is white noise; the blend mode
 * does the visual work (use `overlay` or `screen` over a dark scene to read as
 * "film grain", `multiply` for a heavier dither).
 *
 *   - opacity     mix amount of the noise pass into the scene
 *   - premultiply scale noise by input luminance (grain reads denser in lights)
 */

import { Noise } from "@react-three/postprocessing";

import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { blendFunctionFor } from "./blend";
import { grainSchema } from "../schemas";

interface GrainValues {
  opacity: number;
  premultiply: boolean;
}

function GrainComponent({ layer, values }: LayerComponentProps) {
  const v = values as unknown as GrainValues;
  return (
    <Noise
      blendFunction={blendFunctionFor(layer.blend)}
      opacity={v.opacity}
      premultiply={v.premultiply}
    />
  );
}

export const GrainLayer: LayerDefinition = {
  ...grainSchema,
  Component: GrainComponent,
};
