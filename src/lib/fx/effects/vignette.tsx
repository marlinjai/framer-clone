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
  ParamsSchema,
} from "../types";
import { blendFunctionFor } from "./blend";

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

const VIGNETTE_DEFAULT_PARAMS: ParamsSchema = {
  offset: { type: "number", value: 0.5, min: 0, max: 1, step: 0.01 },
  darkness: { type: "number", value: 0.5, min: 0, max: 1, step: 0.01 },
};

export const VignetteLayer: LayerDefinition = {
  type: "vignette",
  kind: "post",
  label: "Vignette",
  defaultParams: VIGNETTE_DEFAULT_PARAMS,
  Component: VignetteComponent,
};
