"use client";

/**
 * Shape (SDF) content layer (spec section 4 "Content/source layers / Shape").
 *
 * Renders an SDF primitive on a fullscreen quad:
 *
 *   - circle:        |p| - r
 *   - roundedRect:   box SDF with corner radius
 *   - blob:          circle modulated by low-frequency simplex noise
 *
 * The SDF is converted to coverage with `1 - smoothstep(0, softness, d)` so
 * `softness` controls edge feathering (0 = hard, 1 = airy glow). Color +
 * opacity drive the fragment output; the blend mode is applied at the
 * material level through `applyContentBlend`, so a shape can be a mask
 * (multiply), an accent (add/screen), or an opaque hit (normal).
 *
 * Position is a normalized vec2 in [-1, 1] across the plane so the editor
 * can drag the shape anywhere without thinking in world units.
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
import { shapeSchema } from "../schemas";

interface ShapeValues {
  shape: string;
  position: [number, number];
  size: number;
  aspect: number;
  radius: number;
  softness: number;
  color: string;
  opacity: number;
  wobble: number;
}

interface ShapeUniforms {
  [key: string]: THREE.IUniform<unknown>;
  uPremultiply: THREE.IUniform<number>;
  uShape: THREE.IUniform<number>;
  uPosition: THREE.IUniform<THREE.Vector2>;
  uSize: THREE.IUniform<number>;
  uAspect: THREE.IUniform<number>;
  uRadius: THREE.IUniform<number>;
  uSoftness: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
  uOpacity: THREE.IUniform<number>;
  uWobble: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uMouse: THREE.IUniform<THREE.Vector2>;
  uPlaneAspect: THREE.IUniform<number>;
}

const SHAPE_INDEX: Record<string, number> = { circle: 0, roundedRect: 1, blob: 2 };

const SHAPE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SHAPE_FRAG = /* glsl */ `
  uniform float uPremultiply;
  precision highp float;
  uniform int uShape;
  uniform vec2 uPosition;
  uniform float uSize;
  uniform float uAspect;
  uniform float uRadius;
  uniform float uSoftness;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uWobble;
  uniform float uTime;
  uniform vec2 uMouse;
  uniform float uPlaneAspect;
  varying vec2 vUv;

  // 2D simplex noise (Ashima / Stefan Gustavson, MIT) — same routine the
  // noise-fill layer uses. Inlined here so this layer is independent.
  vec3 mod289s(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289s(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permutes(vec3 x) { return mod289s(((x * 34.0) + 1.0) * x); }
  float snoises(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289s(i);
    vec3 p = permutes(permutes(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
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

  // Standard IQ rounded-box SDF: https://iquilezles.org/articles/distfunctions2d/
  float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  void main() {
    // Work in plane-space units (-aspect..aspect, -1..1) so radius reads
    // intuitively regardless of the plane's aspect ratio.
    vec2 p = (vUv - 0.5) * 2.0;
    p.x *= uPlaneAspect;

    // Shape origin from a normalized [-1,1] position. Drift slightly with the
    // smoothed pointer so a layer with interactivity feels alive.
    vec2 center = uPosition + uMouse * 0.4;
    center.x *= uPlaneAspect;
    p -= center;

    float d;
    if (uShape == 1) {
      // Rounded rect: aspect skews the box so a size of 1 fills the same
      // visual area as a circle of size 1.
      vec2 b = vec2(uSize * uAspect, uSize);
      d = sdRoundedBox(p, b, min(uRadius, min(b.x, b.y)));
    } else if (uShape == 2) {
      // Blob: circle radius modulated by simplex noise around the angle.
      float r = uSize;
      float ang = atan(p.y, p.x);
      float n = snoises(vec2(cos(ang), sin(ang)) * 1.6 + uTime * 0.6);
      r += n * uWobble * uSize;
      d = length(p) - r;
    } else {
      // Circle (default).
      d = length(p) - uSize;
    }

    // Convert SDF to coverage with a soft edge.
    float edge = max(uSoftness, 0.001);
    float cov = 1.0 - smoothstep(0.0, edge, d);
    gl_FragColor = vec4(uColor, cov * uOpacity);
    // To the output colour space. Without this a scene with no post pass was
    // drawn too dark: the composer converts at its end, a layer drawn straight
    // to the screen converted nothing. Into the composer's buffer this is the
    // identity, so a scene with a post pass is drawn exactly as before.
    #include <colorspace_fragment>
    // Multiply blends premultiplied colour (see contentBlend): uPremultiply is 1 for it, 0 otherwise.
    gl_FragColor.rgb *= mix(1.0, gl_FragColor.a, uPremultiply);
  }
`;

function ShapeLayerComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as ShapeValues;
  const matRef = useRef<THREE.ShaderMaterial | null>(null);
  const interactivity = useInteractivity();
  const spec = useInteractivitySpec(layer.interactivity);

  const initialUniforms = useMemo<ShapeUniforms>(
    () => ({
      uPremultiply: { value: 0 },
      uShape: { value: SHAPE_INDEX[v.shape] ?? 0 },
      uPosition: { value: new THREE.Vector2(v.position[0], v.position[1]) },
      uSize: { value: v.size },
      uAspect: { value: v.aspect },
      uRadius: { value: v.radius },
      uSoftness: { value: v.softness },
      uColor: { value: new THREE.Color(v.color) },
      uOpacity: { value: v.opacity },
      uWobble: { value: v.wobble },
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uPlaneAspect: { value: 26 / 16 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uShape.value = SHAPE_INDEX[v.shape] ?? 0;
  }, [v.shape]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    (m.uniforms.uPosition.value as THREE.Vector2).set(v.position[0], v.position[1]);
  }, [v.position]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uSize.value = v.size;
  }, [v.size]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uAspect.value = v.aspect;
  }, [v.aspect]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uRadius.value = v.radius;
  }, [v.radius]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uSoftness.value = v.softness;
  }, [v.softness]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    (m.uniforms.uColor.value as THREE.Color).set(v.color);
  }, [v.color]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uOpacity.value = v.opacity;
  }, [v.opacity]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uWobble.value = v.wobble;
  }, [v.wobble]);
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
    m.uniforms.uTime.value = ctx.reduce ? 0 : state.clock.elapsedTime;
    (m.uniforms.uMouse.value as THREE.Vector2).copy(interactivity.mouse);
  });

  return (
    <mesh position={[0, 0, -2.5]}>
      <planeGeometry args={[26, 16]} />
      <shaderMaterial
        ref={(m) => {
          matRef.current = m;
          if (m) applyContentBlend(m, layer.blend);
        }}
        uniforms={initialUniforms}
        vertexShader={SHAPE_VERT}
        fragmentShader={SHAPE_FRAG}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

export const ShapeLayer: LayerDefinition = {
  ...shapeSchema,
  Component: ShapeLayerComponent,
};
