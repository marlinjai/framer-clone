"use client";

/**
 * Particle Ring content layer: Lumitra's brand light, a ring of fine light particles with a glow pass.
 *
 * The shaders and the particle data are in ../particleRingCore (render-free, shared with the tests). The
 * points are drawn as `glow` passes of large faint points, then one pass of fine points, all added (ONE, ONE)
 * with no depth, placed straight in clip space from the box size, so the ring sits centred with the radius
 * `min(0.37 W, 0.47 H)` whatever the camera does.
 *
 * COLOUR: the points are summed in a buffer of the ring's own (8 bits per channel, four samples per pixel,
 * no colour conversion), the same kind of buffer the `<lumitra-light>` canvas is, so the sum, its rounding
 * and its clipping are the component's. A full-box quad then brings the buffer into the scene, decoded to
 * linear light and encoded by three.js's output step: the same bytes on the screen, and the same bytes
 * after a post pass's composer encodes its linear buffer. As the bottom layer (`ctx.bottomLayerId`) the
 * buffer starts from the scene's background and the quad replaces; over other layers it starts from
 * nothing and the quad adds. The pixel oracle holds all of this to the component's picture.
 *
 * BLEND: the ring is light, so it always adds; the layer's blend mode is not applied, and the reader
 * stores "add" for it (../format).
 *
 * POINTER: the canvas takes no pointer events, so the ring leans toward the window's pointer
 * (`useWindowPointer`, -1 to 1, halved to the component's -0.5 to 0.5) at the component's pace. With
 * pointer settings on the layer, the engine's interactivity drives the lean instead, as for the noise field.
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import {
  useInteractivity,
  useInteractivitySpec,
  useWindowPointer,
} from "../interactivity";
import {
  RING_FOLLOW,
  RING_FRAGMENT,
  RING_START_TIME,
  RING_VERTEX,
  buildRingParticles,
  mulberry32,
  ringGlowPasses,
  ringRadius,
} from "../particleRingCore";
import { particleRingSchema } from "../schemas";
import type { LayerComponentProps, LayerDefinition } from "../types";

interface RingValues {
  glow: number;
  density: number;
  seed: number;
  speed: number;
}

function ringMaterial(glow: 0 | 1): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    uniforms: {
      t: { value: RING_START_TIME },
      res: { value: new THREE.Vector2(1, 1) },
      ptr: { value: new THREE.Vector2(0, 0) },
      R: { value: 1 },
      W: { value: 0.2 },
      dpr: { value: 1 },
      glow: { value: glow },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

/** Draws the ring's light buffer over what lies under it, in the space the scene draws in. */
const COMPOSITE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tRing;
  varying vec2 vUv;
  void main() {
    // The buffer holds display-space colour, summed exactly as the component's canvas sums it.
    // Decode to linear light; the output step below encodes it back for the screen (the same bytes)
    // or leaves it linear for a post pass's buffer (so the composer's final encoding gives the same bytes).
    gl_FragColor = sRGBTransferEOTF(vec4(texture2D(tRing, vUv).rgb, 1.0));
    #include <colorspace_fragment>
  }
`;

/**
 * The quad that brings the buffer into the scene. Over other layers it adds the buffer's light (ONE, ONE);
 * as the bottom layer the buffer already holds the background with the light summed onto it, exactly as the
 * component's canvas holds it, and replaces what is there.
 */
function compositeMaterial(texture: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: COMPOSITE_VERTEX,
    fragmentShader: COMPOSITE_FRAGMENT,
    uniforms: { tRing: { value: texture } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

function setCompositeMode(material: THREE.ShaderMaterial, bottom: boolean): void {
  if (bottom) {
    material.blending = THREE.NoBlending;
  } else {
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendEquationAlpha = THREE.AddEquation;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }
  material.needsUpdate = true;
}

/** A stored colour (#rrggbb) as the bytes it is, for a buffer that holds display-space colour. */
function rawColour(hex: string | undefined, into: THREE.Color): THREE.Color {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  const n = m ? parseInt(m[1], 16) : 0;
  return into.setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, THREE.LinearSRGBColorSpace);
}

function ParticleRingComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as RingValues;
  const interactivity = useInteractivity();
  const spec = useInteractivitySpec(layer.interactivity);
  const pointer = useWindowPointer();
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(buildRingParticles(v.density, mulberry32(Math.round(v.seed))), 3));
    return g;
  }, [v.density, v.seed]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const glowMaterial = useMemo(() => ringMaterial(1), []);
  const coreMaterial = useMemo(() => ringMaterial(0), []);

  // The light is summed in a buffer of its own, 8 bits per channel and no colour conversion, the same
  // kind of buffer the component's canvas is: so the sum (and its rounding and clipping) is the
  // component's, whatever the scene draws into.
  const target = useMemo(() => {
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      // The component's canvas is antialiased (four samples per pixel); points blended per sample and then
      // resolved are a different sum from points blended per pixel, so the buffer takes the same four samples.
      samples: 4,
    });
    return rt;
  }, []);
  const composite = useMemo(() => compositeMaterial(target.texture), [target]);
  useEffect(
    () => () => {
      glowMaterial.dispose();
      coreMaterial.dispose();
      composite.dispose();
      target.dispose();
    },
    [glowMaterial, coreMaterial, composite, target],
  );

  // The points live in a scene of their own, drawn into the buffer before the frame; the layer's place in
  // the main scene is the full-box quad that adds the buffer.
  const passes = ringGlowPasses(v.glow);
  const ringScene = useMemo(() => new THREE.Scene(), []);
  useEffect(() => {
    const objects: THREE.Points[] = [];
    for (let i = 0; i < passes; i++) objects.push(new THREE.Points(geometry, glowMaterial));
    objects.push(new THREE.Points(geometry, coreMaterial));
    objects.forEach((o, i) => {
      o.frustumCulled = false;
      o.renderOrder = i;
      ringScene.add(o);
    });
    return () => {
      for (const o of objects) ringScene.remove(o);
    };
  }, [ringScene, geometry, glowMaterial, coreMaterial, passes]);

  const quad = useRef<THREE.Mesh | null>(null);
  useEffect(() => {
    ctx.registerObject(layer.id, quad.current);
    return () => ctx.registerObject(layer.id, null);
  }, [ctx, layer.id]);

  const bottom = ctx.bottomLayerId === layer.id && ctx.background !== undefined;
  useEffect(() => setCompositeMode(composite, bottom), [composite, bottom]);

  const lean = useRef(new THREE.Vector2(0, 0));
  const clear = useMemo(() => new THREE.Color(), []);
  const ground = useMemo(() => new THREE.Color(), []);
  useFrame((state) => {
    const t = ctx.reduce ? RING_START_TIME : RING_START_TIME + state.clock.elapsedTime * v.speed;
    interactivity.step(spec, ctx.reduce);
    if (layer.interactivity) {
      lean.current.set(interactivity.mouse.x * 0.5, interactivity.mouse.y * 0.5);
    } else if (!ctx.reduce) {
      lean.current.x += (pointer.x * 0.5 - lean.current.x) * RING_FOLLOW;
      lean.current.y += (pointer.y * 0.5 - lean.current.y) * RING_FOLLOW;
    }
    const R = ringRadius(size.width, size.height);
    for (const m of [glowMaterial, coreMaterial]) {
      const u = m.uniforms;
      u.t.value = t;
      (u.res.value as THREE.Vector2).set(size.width, size.height);
      (u.ptr.value as THREE.Vector2).copy(lean.current);
      u.R.value = R;
      u.W.value = R * 0.2;
      u.dpr.value = dpr;
    }

    const gl = state.gl;
    const w = Math.max(1, Math.round(size.width * dpr));
    const h = Math.max(1, Math.round(size.height * dpr));
    if (target.width !== w || target.height !== h) target.setSize(w, h);
    const previousTarget = gl.getRenderTarget();
    const previousAlpha = gl.getClearAlpha();
    gl.getClearColor(clear);
    gl.setRenderTarget(target);
    // As the bottom layer the light is summed onto the background itself (each sample clipped at full
    // brightness after the background, as on the component's canvas); over other layers onto nothing.
    if (bottom) gl.setClearColor(rawColour(ctx.background, ground), 1);
    else gl.setClearColor(0x000000, 0);
    gl.clear(true, false, false);
    gl.render(ringScene, state.camera);
    gl.setRenderTarget(previousTarget);
    gl.setClearColor(clear, previousAlpha);
  });

  return (
    <mesh ref={quad} material={composite} frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  );
}

export const ParticleRingLayer: LayerDefinition = {
  ...particleRingSchema,
  Component: ParticleRingComponent,
};
