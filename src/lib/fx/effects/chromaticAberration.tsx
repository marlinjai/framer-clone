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
  ParamsSchema,
} from "../types";
import { blendFunctionFor } from "./blend";

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

const CHROMATIC_DEFAULT_PARAMS: ParamsSchema = {
  offset: {
    type: "vec2",
    value: [0.0007, 0.0004],
    min: [0, 0],
    max: [0.006, 0.006],
    step: 0.0001,
  },
};

export const ChromaticAberrationLayer: LayerDefinition = {
  type: "chromaticAberration",
  kind: "post",
  label: "Chromatic Aberration",
  defaultParams: CHROMATIC_DEFAULT_PARAMS,
  Component: ChromaticAberrationComponent,
};
