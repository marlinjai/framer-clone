/**
 * Map our string BlendMode to `postprocessing`'s BlendFunction enum.
 * Centralized so every post layer agrees on the mapping.
 */

import { BlendFunction } from "postprocessing";

import type { BlendMode } from "../types";

export function blendFunctionFor(mode: BlendMode): BlendFunction {
  switch (mode) {
    case "screen":
      return BlendFunction.SCREEN;
    case "multiply":
      return BlendFunction.MULTIPLY;
    case "add":
      return BlendFunction.ADD;
    case "overlay":
      return BlendFunction.OVERLAY;
    case "normal":
    default:
      return BlendFunction.NORMAL;
  }
}
