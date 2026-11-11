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
} from "../types";
import { bloomSchema } from "../schemas";

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

export const BloomLayer: LayerDefinition = {
  ...bloomSchema,
  Component: BloomComponent,
};
