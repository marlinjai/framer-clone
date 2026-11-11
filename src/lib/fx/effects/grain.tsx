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
  ParamsSchema,
} from "../types";
import { blendFunctionFor } from "./blend";

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

const GRAIN_DEFAULT_PARAMS: ParamsSchema = {
  opacity: { type: "number", value: 0.25, min: 0, max: 1, step: 0.01 },
  premultiply: { type: "bool", value: false },
};

export const GrainLayer: LayerDefinition = {
  type: "grain",
  kind: "post",
  label: "Grain",
  defaultParams: GRAIN_DEFAULT_PARAMS,
  Component: GrainComponent,
};
