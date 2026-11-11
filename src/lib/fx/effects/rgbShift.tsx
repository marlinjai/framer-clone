"use client";

/**
 * RGB Shift post layer (spec section 4.8).
 *
 * Sample R, G, B at slightly offset UVs along a configurable angle. Distinct
 * from `chromaticAberration` (which is a centered vec2 offset): this exposes
 * `amount` + `angle` so the split can rotate, the classic "glitch reveal"
 * dial. Implemented as a custom `postprocessing` Effect with a `mainImage`
 * shader that samples the input three times.
 */

import { wrapEffect } from "@react-three/postprocessing";
import { BlendFunction, Effect } from "postprocessing";
import { Uniform } from "three";

import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { blendFunctionFor } from "./blend";
import { rgbShiftSchema } from "../schemas";

const RGB_SHIFT_FRAG = /* glsl */ `
  uniform float uAmount;
  uniform float uAngle;
  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 off = vec2(cos(uAngle), sin(uAngle)) * uAmount;
    float r = texture2D(inputBuffer, uv + off).r;
    float g = texture2D(inputBuffer, uv).g;
    float b = texture2D(inputBuffer, uv - off).b;
    outputColor = vec4(r, g, b, inputColor.a);
  }
`;

interface RGBShiftOptions {
  amount?: number;
  angle?: number;
  blendFunction?: BlendFunction;
}

class RGBShiftEffect extends Effect {
  constructor({ amount = 0.005, angle = 0, blendFunction = BlendFunction.NORMAL }: RGBShiftOptions = {}) {
    super("RGBShiftEffect", RGB_SHIFT_FRAG, {
      blendFunction,
      uniforms: new Map<string, Uniform>([
        ["uAmount", new Uniform(amount)],
        ["uAngle", new Uniform(angle)],
      ]),
    });
  }

  set amount(value: number) {
    (this.uniforms.get("uAmount") as Uniform).value = value;
  }

  set angle(value: number) {
    (this.uniforms.get("uAngle") as Uniform).value = value;
  }
}

const RGBShift = wrapEffect(RGBShiftEffect);

interface RGBShiftValues {
  amount: number;
  angle: number;
}

function RGBShiftComponent({ layer, values }: LayerComponentProps) {
  const v = values as unknown as RGBShiftValues;
  return (
    <RGBShift
      blendFunction={blendFunctionFor(layer.blend)}
      amount={v.amount}
      angle={v.angle}
    />
  );
}

export const RGBShiftLayer: LayerDefinition = {
  ...rgbShiftSchema,
  Component: RGBShiftComponent,
};
