"use client";

/**
 * Vignette post layer (spec section 4.8).
 *
 * Wraps `postprocessing`'s VignetteEffect via @react-three/postprocessing.
 * Two params:
 *   - offset    how far from center the darkening starts (0 = pinhole, 1 = full)
 *   - darkness  how dark the edges get (0 = none, 1 = black)
 */

import { Vignette } from "@react-three/postprocessing";

import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { blendFunctionFor } from "./blend";
import { vignetteSchema } from "../schemas";

interface VignetteValues {
  offset: number;
  darkness: number;
}

function VignetteComponent({ layer, values }: LayerComponentProps) {
  const v = values as unknown as VignetteValues;
  return (
    <Vignette
      blendFunction={blendFunctionFor(layer.blend)}
      offset={v.offset}
      darkness={v.darkness}
    />
  );
}

export const VignetteLayer: LayerDefinition = {
  ...vignetteSchema,
  Component: VignetteComponent,
};
