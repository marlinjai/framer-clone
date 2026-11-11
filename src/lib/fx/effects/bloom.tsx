"use client";

/**
 * Bloom post layer (spec section 4.2).
 *
 * Threshold bright-pass + mipmap blur + additive composite. Uses
 * `postprocessing`'s BloomEffect via @react-three/postprocessing.
 */

import { Bloom } from "@react-three/postprocessing";
import { KernelSize } from "postprocessing";

import type {
  LayerComponentProps,
  LayerDefinition,
  ParamsSchema,
} from "../types";

interface BloomValues {
  intensity: number;
  threshold: number;
  radius: number;
}

function BloomComponent({ values }: LayerComponentProps) {
  const v = values as unknown as BloomValues;
  return (
    <Bloom
      intensity={v.intensity}
      luminanceThreshold={v.threshold}
      luminanceSmoothing={0.85}
      mipmapBlur
      radius={v.radius}
      kernelSize={KernelSize.LARGE}
    />
  );
}

const BLOOM_DEFAULT_PARAMS: ParamsSchema = {
  intensity: { type: "number", value: 0.7, min: 0, max: 3, step: 0.05 },
  threshold: { type: "number", value: 0.5, min: 0, max: 1, step: 0.01 },
  radius: { type: "number", value: 0.62, min: 0, max: 1, step: 0.02 },
};

export const BloomLayer: LayerDefinition = {
  type: "bloom",
  kind: "post",
  label: "Bloom",
  // Mipmap blur pyramid + multi-pass composite. The PerformanceMonitor
  // downshift drops this first on low-end devices.
  heavy: true,
  defaultParams: BLOOM_DEFAULT_PARAMS,
  Component: BloomComponent,
};
