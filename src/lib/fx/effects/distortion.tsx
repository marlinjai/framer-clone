"use client";

/**
 * Distortion / displacement post layer (spec section 4.6).
 *
 * UVs are offset by a procedural noise field, optionally pulled toward the
 * mouse:
 *
 *   uv += (snoise(uv * uScale + uTime * uSpeed).xy * 2 - 1) * uStrength
 *
 * Three modes (`type` param):
 *   - "noise"  full-screen wandering displacement
 *   - "ripple" radial wave from the mouse (or screen center)
 *   - "texture" alias of "noise" for now; reserved for a future image-driven
 *               displacement map (spec section 4.6 "type: noise/texture/ripple")
 *
 * `mouseInfluence` mixes the mouse into the displacement origin / ripple
 * center. Mouse is delivered through a uniform we update each frame from the
 * r3f event loop (no Three import outside this effect; we read pointer via a
 * tiny `useFrame` hook).
 */

import { extend, useFrame, type ThreeElement } from "@react-three/fiber";
import { BlendFunction, Effect } from "postprocessing";
import { useRef } from "react";
import { Uniform, Vector2 } from "three";

import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { blendFunctionFor } from "./blend";
import { distortionSchema } from "../schemas";

const DISTORTION_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uMouseInfluence;
  uniform vec2 uMouse;          // [-1, 1] screen space
  uniform int uMode;            // 0 = noise, 1 = ripple, 2 = texture (alias of noise)

  // 2D simplex noise (Ashima / Stefan Gustavson, MIT).
  vec3 mod289d(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289d(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permuted(vec3 x) { return mod289d(((x * 34.0) + 1.0) * x); }
  float snoised(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289d(i);
    vec3 p = permuted(permuted(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void mainUv(inout vec2 uv) {
    vec2 mouseUv = uMouse * 0.5 + 0.5; // map [-1,1] -> [0,1]
    if (uMode == 1) {
      // Ripple: radial wave around the mouse (or center if mouseInfluence is 0).
      vec2 center = mix(vec2(0.5), mouseUv, uMouseInfluence);
      vec2 d = uv - center;
      float r = length(d);
      float wave = sin(r * uScale * 8.0 - uTime * uSpeed * 4.0);
      uv += (d / max(r, 1e-4)) * wave * uStrength;
    } else {
      // "noise" (default) and "texture" alias: two-channel noise lookup.
      vec2 sampleUv = uv * uScale + (mouseUv - 0.5) * uMouseInfluence;
      float nx = snoised(sampleUv + vec2(uTime * uSpeed, 0.0));
      float ny = snoised(sampleUv + vec2(0.0, uTime * uSpeed + 13.7));
      uv += vec2(nx, ny) * uStrength;
    }
  }
`;

interface DistortionOptions {
  strength?: number;
  scale?: number;
  speed?: number;
  mouseInfluence?: number;
  mode?: number;
  blendFunction?: BlendFunction;
}

class DistortionEffect extends Effect {
  constructor({
    strength = 0.02,
    scale = 3,
    speed = 0.5,
    mouseInfluence = 0,
    mode = 0,
    blendFunction = BlendFunction.NORMAL,
  }: DistortionOptions = {}) {
    super("DistortionEffect", DISTORTION_FRAG, {
      blendFunction,
      uniforms: new Map<string, Uniform>([
        ["uTime", new Uniform(0)],
        ["uStrength", new Uniform(strength)],
        ["uScale", new Uniform(scale)],
        ["uSpeed", new Uniform(speed)],
        ["uMouseInfluence", new Uniform(mouseInfluence)],
        ["uMouse", new Uniform(new Vector2(0, 0))],
        ["uMode", new Uniform(mode)],
      ]),
    });
  }

  set strength(value: number) {
    (this.uniforms.get("uStrength") as Uniform).value = value;
  }
  set scale(value: number) {
    (this.uniforms.get("uScale") as Uniform).value = value;
  }
  set speed(value: number) {
    (this.uniforms.get("uSpeed") as Uniform).value = value;
  }
  set mouseInfluence(value: number) {
    (this.uniforms.get("uMouseInfluence") as Uniform).value = value;
  }
  set mode(value: number) {
    (this.uniforms.get("uMode") as Uniform).value = value;
  }

  // Time + mouse are driven from the host's `useFrame` via the setters below;
  // the engine's `ctx.reduce` (prefers-reduced-motion) can then pin time to 0
  // for a static frame.
  setTime(t: number): void {
    (this.uniforms.get("uTime") as Uniform).value = t;
  }
  setMouse(x: number, y: number): void {
    const m = this.uniforms.get("uMouse") as Uniform;
    (m.value as Vector2).set(x, y);
  }
}

// Register the custom effect as an R3F intrinsic so we can render it as
// `<distortionEffect>` and let R3F own its ref. We deliberately do NOT use
// `@react-three/postprocessing`'s `wrapEffect`: it is not a forwardRef
// component, so under React 19 the `ref` arrives as a normal prop, lands in
// wrapEffect's `...props`, and its `JSON.stringify(props)` memo key then chokes
// on the mounted effect's circular parent/children graph ("Converting circular
// structure to JSON"). Same latent crash as the bokeh layer; same fix.
extend({ DistortionEffect });

declare module "@react-three/fiber" {
  interface ThreeElements {
    distortionEffect: ThreeElement<typeof DistortionEffect>;
  }
}

const MODE_INDEX: Record<string, number> = { noise: 0, ripple: 1, texture: 2 };

interface DistortionValues {
  type: string;
  strength: number;
  scale: number;
  speed: number;
  mouseInfluence: number;
}

function DistortionComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as DistortionValues;
  const ref = useRef<DistortionEffect | null>(null);
  // Smoothed mouse state lives in a ref so the per-frame mutation is opaque
  // to react-hooks' immutability rule (refs are the documented escape hatch).
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useFrame((state) => {
    const eff = ref.current;
    if (!eff) return;
    // Sync the static uniforms each frame (cheap writes, no recompile).
    // `blendFunction` is guarded because its setter dispatches a recompile.
    eff.strength = v.strength;
    eff.scale = v.scale;
    eff.speed = v.speed;
    eff.mouseInfluence = v.mouseInfluence;
    eff.mode = MODE_INDEX[v.type] ?? 0;
    const blendFunction = blendFunctionFor(layer.blend);
    if (eff.blendMode.blendFunction !== blendFunction) {
      eff.blendMode.blendFunction = blendFunction;
    }
    const t = ctx.reduce ? 0 : state.clock.elapsedTime;
    eff.setTime(t);
    if (ctx.reduce) {
      eff.setMouse(0, 0);
      return;
    }
    // Match the rest of the engine's smoothing factor (0.04) so distortion's
    // mouse motion lines up with NoiseField / Text parallax instead of leading.
    const m = mouseRef.current;
    m.x += (state.pointer.x - m.x) * 0.04;
    m.y += (state.pointer.y - m.y) * 0.04;
    eff.setMouse(m.x, m.y);
  });

  return <distortionEffect ref={ref} />;
}

export const DistortionLayer: LayerDefinition = {
  ...distortionSchema,
  Component: DistortionComponent,
};
