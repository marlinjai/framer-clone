"use client";

/**
 * God Rays post layer (spec section 4.1).
 *
 * Radial blur from a bright source mesh's screen-space position. The "sun" is
 * resolved by `sourceLayerId` against the scene's object registry, so the
 * lockup text layer feeds it without either side knowing about the other.
 */

import { GodRays } from "@react-three/postprocessing";
import { KernelSize } from "postprocessing";
import { Mesh } from "three";

import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { blendFunctionFor } from "./blend";
import { godRaysSchema } from "../schemas";

interface GodRaysValues {
  sourceLayerId: string;
  density: number;
  decay: number;
  weight: number;
  exposure: number;
  samples: number;
  clampMax: number;
}

function GodRaysComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as GodRaysValues;
  const sun = ctx.getObject(v.sourceLayerId);
  // LumitraScene already gates the composer on this; this guard is a belt for
  // the brace in case the layer order changes in a future scene.
  if (!sun || !(sun instanceof Mesh)) return null;
  return (
    <GodRays
      // Force a fresh effect when sample count changes (kernel size depends on it).
      key={v.samples}
      sun={sun}
      blendFunction={blendFunctionFor(layer.blend)}
      samples={v.samples}
      density={v.density}
      decay={v.decay}
      weight={v.weight}
      exposure={v.exposure}
      clampMax={v.clampMax}
      kernelSize={KernelSize.SMALL}
      blur
    />
  );
}

export const GodRaysLayer: LayerDefinition = {
  ...godRaysSchema,
  Component: GodRaysComponent,
};
