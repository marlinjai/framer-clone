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
  ParamsSchema,
} from "../types";
import { blendFunctionFor } from "./blend";

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

const GOD_RAYS_DEFAULT_PARAMS: ParamsSchema = {
  sourceLayerId: { type: "select", value: "text-lockup", options: ["text-lockup"] },
  density: { type: "number", value: 0.92, min: 0.8, max: 1, step: 0.005 },
  decay: { type: "number", value: 0.9, min: 0.8, max: 0.99, step: 0.005 },
  weight: { type: "number", value: 0.3, min: 0, max: 1, step: 0.01 },
  exposure: { type: "number", value: 0.18, min: 0, max: 0.6, step: 0.01 },
  samples: { type: "number", value: 60, min: 20, max: 120, step: 5 },
  clampMax: { type: "number", value: 0.9, min: 0.5, max: 1, step: 0.01 },
};

export const GodRaysLayer: LayerDefinition = {
  type: "godRays",
  kind: "post",
  label: "God Rays",
  // Per-pixel radial sample loop; heaviest pass in the v1 set after Bloom.
  heavy: true,
  defaultParams: GOD_RAYS_DEFAULT_PARAMS,
  Component: GodRaysComponent,
};
