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
} from "../types";
import { blendFunctionFor } from "./blend";
import { halftoneSchema } from "../schemas";

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

export const HalftoneLayer: LayerDefinition = {
  ...halftoneSchema,
  Component: HalftoneComponent,
};
