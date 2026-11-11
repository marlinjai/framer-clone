"use client";

/**
 * Halftone / Dot screen post layer (spec section 4.8).
 *
 * Wraps `postprocessing`'s DotScreenEffect via @react-three/postprocessing.
 * The DotScreen pass overlays a sinusoidal dot pattern whose density tracks
 * scene luminance, the standard print-halftone trick.
 *
 *   - angle    rotation of the dot grid (radians)
 *   - scale    grid scale; higher = finer dots
 *
 * Blend defaults to `normal` for a pure replacement look; flip to `multiply`
 * or `overlay` from the editor to keep more of the underlying scene.
 */

import { DotScreen } from "@react-three/postprocessing";

import type {
  LayerComponentProps,
  LayerDefinition,
  ParamsSchema,
} from "../types";
import { blendFunctionFor } from "./blend";

interface HalftoneValues {
  angle: number;
  scale: number;
}

function HalftoneComponent({ layer, values }: LayerComponentProps) {
  const v = values as unknown as HalftoneValues;
  return (
    <DotScreen
      blendFunction={blendFunctionFor(layer.blend)}
      angle={v.angle}
      scale={v.scale}
    />
  );
}

const HALFTONE_DEFAULT_PARAMS: ParamsSchema = {
  angle: { type: "number", value: 1.57, min: 0, max: Math.PI * 2, step: 0.01 },
  scale: { type: "number", value: 1, min: 0.2, max: 5, step: 0.05 },
};

export const HalftoneLayer: LayerDefinition = {
  type: "halftone",
  kind: "post",
  defaultParams: HALFTONE_DEFAULT_PARAMS,
  Component: HalftoneComponent,
};
