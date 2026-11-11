"use client";

/**
 * Bokeh / Depth of Field post layer (spec section 4.3).
 *
 * The scene is 2D (planes at slightly different z), so the spec calls for the
 * "mix radius" mask approach rather than a true CoC-from-depth DoF. The
 * params line up 1:1 with Unicorn's Bokeh + mix-radius pair:
 *
 *   - radius       max blur radius in UV space (0..0.2)
 *   - mixRadius    distance from focusPos at which the mask reaches 1
 *   - easing       softness of the mask edge (smoothstep half-width)
 *   - focusPos     vec2 in [-1, 1], 0,0 = screen center
 *   - invert       flip the mask (blur inside the focus disc, sharp outside)
 *   - reveal       intro focus-pull duration in seconds; when > 0, eases the
 *                  effective radius from its set value down to 0 over `reveal`
 *                  (spec 4.3 use case: "animate radius high -> 0").
 *
 * Implementation: a single-pass disc-sample shader using a 16-tap golden-angle
 * spiral. Cheaper than postprocessing's DepthOfFieldEffect (which runs four
 * passes: CoC + downsample + foreground/background blur + combine) and matches
 * the mask design exactly. We sample `inputBuffer` (the upstream pipeline's
 * frame) so the bokeh sits naturally in the post stack between bloom and
 * grain.
 *
 * Why not DepthOfFieldEffect: it expects a real depth buffer keyed by
 * focusDistance / focusRange in world units. Our planes sit at z = -3 to -2.5
 * which would collapse to a narrow CoC band that's hard to author. Mask-based
 * bokeh is what the spec asks for ("mix radius mask matching Unicorn's Bokeh
 * radius + mix radius") and it is also the cheapest way to hit the Phase 3
 * frame budget with the full effect stack mounted.
 */

import { extend, useFrame, type ThreeElement } from "@react-three/fiber";
import { BlendFunction, Effect } from "postprocessing";
import { useEffect, useRef } from "react";
import { Uniform, Vector2 } from "three";

import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { blendFunctionFor } from "./blend";
import { bokehSchema } from "../schemas";

// 16-tap golden-angle disc sample. Single-pass; the radius and mask are
// per-pixel so the focus-pull animation is just a uniform write.
const BOKEH_FRAG = /* glsl */ `
  uniform float uRadius;
  uniform float uMixRadius;
  uniform float uEasing;
  uniform vec2  uFocusPos;     // [-1, 1]
  uniform float uInvert;        // 0 = blur outside focus, 1 = blur inside
  uniform float uReveal;        // 0..1 multiplier on radius for intro focus-pull
  uniform float uAspect;        // viewport aspect, so mix-radius is circular

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    // Distance from this pixel to the focus point, in aspect-corrected UV.
    vec2 fp = uFocusPos * 0.5 + 0.5;            // map [-1,1] -> [0,1]
    vec2 d  = (uv - fp) * vec2(uAspect, 1.0);
    float dist = length(d);

    // Mask: smoothstep gives a soft edge controlled by uEasing.
    float edge = max(uEasing, 0.0001);
    float mask = smoothstep(uMixRadius - edge, uMixRadius + edge, dist);
    if (uInvert > 0.5) mask = 1.0 - mask;

    // Effective blur radius for this pixel. uReveal scales the whole thing
    // so the focus-pull animation is one uniform write away.
    float r = uRadius * mask * uReveal;
    if (r < 0.0005) {
      outputColor = inputColor;
      return;
    }

    // Golden-angle (~137.5deg) disc spiral. Each successive sample lies on a
    // ring at sqrt(i/N) so the disc is sampled uniformly by area, not by ring.
    const float PHI = 2.39996323;
    vec3 acc = inputColor.rgb;
    float taps = 1.0;
    for (int i = 1; i < 16; i++) {
      float fi = float(i);
      float ang = fi * PHI;
      float rad = r * sqrt(fi / 15.0);
      vec2 off = vec2(cos(ang) / uAspect, sin(ang)) * rad;
      acc += texture2D(inputBuffer, uv + off).rgb;
      taps += 1.0;
    }
    outputColor = vec4(acc / taps, inputColor.a);
  }
`;

interface BokehOptions {
  radius?: number;
  mixRadius?: number;
  easing?: number;
  focusPos?: [number, number];
  invert?: boolean;
  blendFunction?: BlendFunction;
}

class BokehMixEffect extends Effect {
  constructor({
    radius = 0.02,
    mixRadius = 0.35,
    easing = 0.15,
    focusPos = [0, 0],
    invert = false,
    blendFunction = BlendFunction.NORMAL,
  }: BokehOptions = {}) {
    super("BokehMixEffect", BOKEH_FRAG, {
      blendFunction,
      uniforms: new Map<string, Uniform>([
        ["uRadius", new Uniform(radius)],
        ["uMixRadius", new Uniform(mixRadius)],
        ["uEasing", new Uniform(easing)],
        ["uFocusPos", new Uniform(new Vector2(focusPos[0], focusPos[1]))],
        ["uInvert", new Uniform(invert ? 1 : 0)],
        ["uReveal", new Uniform(1)],
        ["uAspect", new Uniform(16 / 9)],
      ]),
    });
  }

  set radius(value: number) {
    (this.uniforms.get("uRadius") as Uniform).value = value;
  }
  set mixRadius(value: number) {
    (this.uniforms.get("uMixRadius") as Uniform).value = value;
  }
  set easing(value: number) {
    (this.uniforms.get("uEasing") as Uniform).value = value;
  }
  set invert(value: boolean) {
    (this.uniforms.get("uInvert") as Uniform).value = value ? 1 : 0;
  }

  setFocusPos(x: number, y: number): void {
    const u = this.uniforms.get("uFocusPos") as Uniform;
    (u.value as Vector2).set(x, y);
  }
  setReveal(value: number): void {
    (this.uniforms.get("uReveal") as Uniform).value = value;
  }
  setAspect(value: number): void {
    (this.uniforms.get("uAspect") as Uniform).value = value;
  }
}

// Register the custom effect as an R3F intrinsic so we can render it as
// `<bokehMixEffect>` and let R3F own its ref + lifecycle. We deliberately do
// NOT use `@react-three/postprocessing`'s `wrapEffect`: it is not a forwardRef
// component, so under React 19 the `ref` arrives as a normal prop, lands in
// wrapEffect's `...props`, and its `JSON.stringify(props)` memo key then chokes
// on the mounted effect's circular parent/children graph ("Converting circular
// structure to JSON"). Rendering the extended intrinsic sidesteps that while
// keeping the EffectComposer's instanceof-based pass detection.
extend({ BokehMixEffect });

declare module "@react-three/fiber" {
  interface ThreeElements {
    bokehMixEffect: ThreeElement<typeof BokehMixEffect>;
  }
}

interface BokehValues {
  radius: number;
  mixRadius: number;
  easing: number;
  focusPos: [number, number];
  invert: boolean;
  reveal: number;
}

function BokehComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as BokehValues;
  // Construct the effect once and drive it imperatively via a <primitive>.
  // We deliberately do NOT use `@react-three/postprocessing`'s `wrapEffect`
  // ref forwarding: it is not a forwardRef component, so under React 19 the
  // `ref` arrives as a normal prop, lands in wrapEffect's `...props`, and its
  // `JSON.stringify(props)` memo key then chokes on the mounted effect's
  // circular parent/children graph ("Converting circular structure to JSON").
  // Rendering the effect as a <primitive> sidesteps that entirely and is the
  // standard custom-effect path; the EffectComposer picks it up by instanceof.
  const ref = useRef<BokehMixEffect | null>(null);
  const startedAt = useRef<number | null>(null);

  // Reset the reveal animation when the duration param flips (so the editor
  // can re-trigger the focus-pull by scrubbing `reveal`).
  useEffect(() => {
    startedAt.current = null;
  }, [v.reveal]);

  useFrame((state) => {
    const eff = ref.current;
    if (!eff) return;
    // Sync the static uniforms each frame (cheap writes, no recompile).
    // `blendFunction` is guarded because its setter dispatches a recompile.
    eff.radius = v.radius;
    eff.mixRadius = v.mixRadius;
    eff.easing = v.easing;
    eff.invert = v.invert;
    const blendFunction = blendFunctionFor(layer.blend);
    if (eff.blendMode.blendFunction !== blendFunction) {
      eff.blendMode.blendFunction = blendFunction;
    }
    // Keep aspect in sync with the canvas so the mask reads as a circle.
    const size = state.size;
    eff.setAspect(size.width / Math.max(1, size.height));
    // Reveal: eases radius from full -> 0 over `reveal` seconds. When the
    // reveal is 0 (default) the bokeh stays at its set radius continuously.
    // Reduce-motion collapses the reveal to its final frame (radius * 0).
    if (v.reveal > 0) {
      if (startedAt.current === null) startedAt.current = state.clock.elapsedTime;
      if (ctx.reduce) {
        eff.setReveal(0);
      } else {
        const t = state.clock.elapsedTime - startedAt.current;
        const k = Math.min(1, Math.max(0, t / v.reveal));
        // ease-out cubic so the focus snaps then settles, matching the
        // intro-sequence reveal feel.
        const eased = 1 - Math.pow(k, 3);
        eff.setReveal(eased);
      }
    } else {
      eff.setReveal(1);
    }
    eff.setFocusPos(v.focusPos[0], v.focusPos[1]);
  });

  return <bokehMixEffect ref={ref} />;
}

export const BokehLayer: LayerDefinition = {
  ...bokehSchema,
  Component: BokehComponent,
};
