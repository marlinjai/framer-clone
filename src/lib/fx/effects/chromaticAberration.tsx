"use client";

/**
 * Chromatic Aberration post layer (spec section 4.5).
 *
 * Per-channel UV offset; we expose offset as a vec2 param so the editor can
 * scrub X and Y independently. Radial modulation is off in Phase 0 to match
 * v7; a Phase 1+ scene can add it as another bool/number param.
 */

import { ChromaticAberration } from "@react-three/postprocessing";
import { useMemo } from "react";
import { Vector2 } from "three";

import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { blendFunctionFor } from "./blend";
import { chromaticAberrationSchema } from "../schemas";

interface ChromaticValues {
  offset: [number, number];
}

function ChromaticAberrationComponent({ layer, values }: LayerComponentProps) {
  const v = values as unknown as ChromaticValues;
  const offset = useMemo(() => new Vector2(v.offset[0], v.offset[1]), [v.offset]);
  return (
    <ChromaticAberration
      blendFunction={blendFunctionFor(layer.blend)}
      offset={offset}
      radialModulation={false}
      modulationOffset={0}
    />
  );
}

export const ChromaticAberrationLayer: LayerDefinition = {
  ...chromaticAberrationSchema,
  Component: ChromaticAberrationComponent,
};
