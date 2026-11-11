"use client";

/**
 * Noise Fill content layer (spec section 4.4).
 *
 * Fullscreen plane running fbm over Ashima 2D simplex noise, mapped to a
 * single tinted ramp with a soft vignette, animated by time and gently
 * pushed by the smoothed mouse vector. Already proven on v7.
 */

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import {
  useInteractivity,
  useInteractivitySpec,
} from "../interactivity";
import type {
  LayerComponentProps,
  LayerDefinition,
} from "../types";
import { applyContentBlend } from "./contentBlend";
import { noiseFillSchema } from "../schemas";

interface NoiseValues {
  color: string;
  scale: number;
  speed: number;
  intensity: number;
}

interface NoiseUniforms {
  [key: string]: THREE.IUniform<unknown>;
  uTime: THREE.IUniform<number>;
  uMouse: THREE.IUniform<THREE.Vector2>;
  uScale: THREE.IUniform<number>;
  uIntensity: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
}

const NOISE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NOISE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec2 uMouse;
  uniform float uScale;
  uniform float uIntensity;
  uniform vec3 uColor;
  varying vec2 vUv;
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
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
  float fbm(vec2 p) {
    float f = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      f += a * snoise(p);
      p *= 2.0;
      a *= 0.5;
    }
    return f;
  }
  void main() {
    vec2 p = vUv * uScale + uMouse * 0.35;
    float n = fbm(p + vec2(uTime * 0.025, uTime * 0.018));
    n = smoothstep(0.1, 1.0, n * 0.5 + 0.5);
    float vig = smoothstep(1.0, 0.25, distance(vUv, vec2(0.5)));
    gl_FragColor = vec4(uColor * n * uIntensity * vig, n * uIntensity * 1.1 * vig);
  }
`;

function NoiseFieldComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as NoiseValues;
  const interactivity = useInteractivity();
  const spec = useInteractivitySpec(layer.interactivity);

  // The initial uniforms object is computed once. After mount, we mutate the
  // live `material.uniforms` via the material ref (refs are designed for
  // exactly this), never the captured `initialUniforms` value. Keeps the
  // strict react-hooks/immutability rule happy.
  const initialUniforms = useMemo<NoiseUniforms>(
    () => ({
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uScale: { value: v.scale },
      uIntensity: { value: v.intensity },
      uColor: { value: new THREE.Color(v.color) },
    }),
    // Created once per mount; subsequent param changes flow through matRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const matRef = useRef<THREE.ShaderMaterial | null>(null);

  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    (m.uniforms.uColor.value as THREE.Color).set(v.color);
  }, [v.color]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uScale.value = v.scale;
  }, [v.scale]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uIntensity.value = v.intensity;
  }, [v.intensity]);

  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    applyContentBlend(m, layer.blend);
    m.needsUpdate = true;
  }, [layer.blend]);

  useFrame((state) => {
    const m = matRef.current;
    if (!m) return;
    const u = m.uniforms;
    u.uTime.value = ctx.reduce ? 2.0 : state.clock.elapsedTime * v.speed;
    interactivity.step(spec, ctx.reduce);
    // If the layer declares interactivity, the bus drives mouse; otherwise
    // keep the legacy v7 lerp so the hero feels exactly the same.
    if (layer.interactivity) {
      (u.uMouse.value as THREE.Vector2).copy(interactivity.mouse);
    } else if (!ctx.reduce) {
      const mouse = u.uMouse.value as THREE.Vector2;
      mouse.x += (state.pointer.x - mouse.x) * 0.04;
      mouse.y += (state.pointer.y - mouse.y) * 0.04;
    }
  });

  return (
    <mesh position={[0, 0, -3]}>
      <planeGeometry args={[26, 16]} />
      <shaderMaterial
        ref={(m) => {
          matRef.current = m;
          if (m) applyContentBlend(m, layer.blend);
        }}
        uniforms={initialUniforms}
        fragmentShader={NOISE_FRAG}
        vertexShader={NOISE_VERT}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

export const NoiseFillLayer: LayerDefinition = {
  ...noiseFillSchema,
  Component: NoiseFieldComponent,
};
