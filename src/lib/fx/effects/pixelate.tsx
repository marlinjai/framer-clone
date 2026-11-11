"use client";

/**
 * Pixelate post layer (spec section 4.8).
 *
 * Wraps `postprocessing`'s PixelationEffect via @react-three/postprocessing.
 * A single `granularity` knob: higher = chunkier pixels. The effect snaps
 * sample coordinates to a coarse grid; useful as a "loading" or "8-bit"
 * style pass, and a cheap cousin to halftone for low-fi looks.
 */

import { Pixelation } from "@react-three/postprocessing";

import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { pixelateSchema } from "../schemas";

interface PixelateValues {
  granularity: number;
}

function PixelateComponent({ values }: LayerComponentProps) {
  const v = values as unknown as PixelateValues;
  return <Pixelation granularity={v.granularity} />;
}

export const PixelateLayer: LayerDefinition = {
  ...pixelateSchema,
  Component: PixelateComponent,
};
