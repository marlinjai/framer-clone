"use client";

/**
 * Gradient / mesh-gradient content layer (spec section 4.10).
 *
 * "Calm cousin of Noise Fill": four color points drift on cheap sin/cos
 * orbits (so the motion is buttery and predictable for a background), and
 * the fragment color is an inverse-distance-weighted blend of the four
 * colors at each pixel. The result is the stripe/codrops-style "mesh
 * gradient" look without any actual mesh tessellation.
 *
 * The weighting falls back to `pow(1/dist, falloff)` so a higher `falloff`
 * makes each color stick closer to its point (more "blob"-y), lower makes
 * the whole frame mix evenly.
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
import { gradientSchema } from "../schemas";

interface GradientValues {
  colorA: string;
  colorB: string;
  colorC: string;
  colorD: string;
  speed: number;
  scale: number;
  falloff: number;
  opacity: number;
}

interface GradientUniforms {
  [key: string]: THREE.IUniform<unknown>;
  uPremultiply: THREE.IUniform<number>;
  uColorA: THREE.IUniform<THREE.Color>;
  uColorB: THREE.IUniform<THREE.Color>;
  uColorC: THREE.IUniform<THREE.Color>;
  uColorD: THREE.IUniform<THREE.Color>;
  uSpeed: THREE.IUniform<number>;
  uScale: THREE.IUniform<number>;
  uFalloff: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uMouse: THREE.IUniform<THREE.Vector2>;
}

const GRADIENT_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GRADIENT_FRAG = /* glsl */ `
  uniform float uPremultiply;
  precision highp float;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform vec3 uColorD;
  uniform float uSpeed;
  uniform float uScale;
  uniform float uFalloff;
  uniform float uOpacity;
  uniform float uTime;
  uniform vec2 uMouse;
  varying vec2 vUv;

  // Inverse-distance weighting (Shepard's method, falloff exponent tunable).
  // Center of mass of the four colors at this pixel, weighted by 1/dist^k.
  vec3 mixFour(vec2 p, vec3 ca, vec2 pa, vec3 cb, vec2 pb, vec3 cc, vec2 pc, vec3 cd, vec2 pd, float k) {
    float wa = 1.0 / pow(distance(p, pa) + 1e-3, k);
    float wb = 1.0 / pow(distance(p, pb) + 1e-3, k);
    float wc = 1.0 / pow(distance(p, pc) + 1e-3, k);
    float wd = 1.0 / pow(distance(p, pd) + 1e-3, k);
    float ws = wa + wb + wc + wd;
    return (ca * wa + cb * wb + cc * wc + cd * wd) / ws;
  }

  void main() {
    // p in [-0.5, 0.5], aspect-square independent — the gradient's stripe
    // pattern is then driven by each point moving on a sin/cos orbit.
    vec2 p = vUv - 0.5;
    float t = uTime * uSpeed;
    // Four points drift on phase-shifted orbits. Mouse adds a small global
    // pull so the gradient breathes with the pointer when interactivity is on.
    vec2 pa = vec2(sin(t * 0.31) * 0.45, cos(t * 0.27) * 0.45) * uScale + uMouse * 0.05;
    vec2 pb = vec2(cos(t * 0.23) * 0.45, sin(t * 0.41) * 0.45) * uScale + uMouse * 0.05;
    vec2 pc = vec2(sin(t * 0.37 + 1.7) * 0.45, cos(t * 0.19 + 2.1) * 0.45) * uScale + uMouse * 0.05;
    vec2 pd = vec2(cos(t * 0.29 + 0.9) * 0.45, sin(t * 0.33 + 3.3) * 0.45) * uScale + uMouse * 0.05;
    vec3 col = mixFour(p, uColorA, pa, uColorB, pb, uColorC, pc, uColorD, pd, uFalloff);
    gl_FragColor = vec4(col, uOpacity);
    // To the output colour space. Without this a scene with no post pass was
    // drawn too dark: the composer converts at its end, a layer drawn straight
    // to the screen converted nothing. Into the composer's buffer this is the
    // identity, so a scene with a post pass is drawn exactly as before.
    #include <colorspace_fragment>
    // Multiply blends premultiplied colour (see contentBlend): uPremultiply is 1 for it, 0 otherwise.
    gl_FragColor.rgb *= mix(1.0, gl_FragColor.a, uPremultiply);
  }
`;

function GradientLayerComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as GradientValues;
  const matRef = useRef<THREE.ShaderMaterial | null>(null);
  const interactivity = useInteractivity();
  const spec = useInteractivitySpec(layer.interactivity);

  const initialUniforms = useMemo<GradientUniforms>(
    () => ({
      uPremultiply: { value: 0 },
      uColorA: { value: new THREE.Color(v.colorA) },
      uColorB: { value: new THREE.Color(v.colorB) },
      uColorC: { value: new THREE.Color(v.colorC) },
      uColorD: { value: new THREE.Color(v.colorD) },
      uSpeed: { value: v.speed },
      uScale: { value: v.scale },
      uFalloff: { value: v.falloff },
      uOpacity: { value: v.opacity },
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    (m.uniforms.uColorA.value as THREE.Color).set(v.colorA);
  }, [v.colorA]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    (m.uniforms.uColorB.value as THREE.Color).set(v.colorB);
  }, [v.colorB]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    (m.uniforms.uColorC.value as THREE.Color).set(v.colorC);
  }, [v.colorC]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    (m.uniforms.uColorD.value as THREE.Color).set(v.colorD);
  }, [v.colorD]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uSpeed.value = v.speed;
  }, [v.speed]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uScale.value = v.scale;
  }, [v.scale]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uFalloff.value = v.falloff;
  }, [v.falloff]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uOpacity.value = v.opacity;
  }, [v.opacity]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    applyContentBlend(m, layer.blend);
    m.needsUpdate = true;
  }, [layer.blend]);

  useFrame((state) => {
    const m = matRef.current;
    if (!m) return;
    interactivity.step(spec, ctx.reduce);
    m.uniforms.uTime.value = ctx.reduce ? 2.0 : state.clock.elapsedTime;
    (m.uniforms.uMouse.value as THREE.Vector2).copy(interactivity.mouse);
  });

  return (
    <mesh position={[0, 0, -3.2]}>
      <planeGeometry args={[26, 16]} />
      <shaderMaterial
        ref={(m) => {
          matRef.current = m;
          if (m) applyContentBlend(m, layer.blend);
        }}
        uniforms={initialUniforms}
        vertexShader={GRADIENT_VERT}
        fragmentShader={GRADIENT_FRAG}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

export const GradientLayer: LayerDefinition = {
  ...gradientSchema,
  Component: GradientLayerComponent,
};
