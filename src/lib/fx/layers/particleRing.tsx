"use client";

/**
 * Particle Ring content layer: Lumitra's brand light, a ring of fine light particles with a glow pass.
 *
 * The shaders and the particle data are in ../particleRingCore (render-free, shared with the tests). The
 * points are drawn as up to two passes of large faint points (the glow: a whole pass per whole number of
 * `glow`, the part of a number that is left as a pass drawing that share of its points, `ringGlowWeights`), then one pass of
 * fine points, all added (ONE, ONE)
 * with no depth, placed straight in clip space from the box size, so the ring sits centred with the radius
 * `min(0.37 W, 0.47 H)` whatever the camera does.
 *
 * COLOUR: the points are summed in a buffer of the ring's own (8 bits per channel, four samples per pixel,
 * no colour conversion), the same kind of buffer the `<lumitra-light>` canvas is, so the sum, its rounding
 * and its clipping are the component's. A full-box quad then brings the buffer into the scene, decoded to
 * linear light and encoded by three.js's output step: the same bytes on the screen, and the same bytes
 * after a post pass's composer encodes its linear buffer. As the only content layer (`ctx.bottomLayerId`) the
 * buffer starts from the scene's background (as three.js parsed it for the canvas) and the quad replaces;
 * with other content layers it starts from nothing and the quad adds. The pixel oracle holds all of this to
 * the component's picture.
 *
 * ORDER: three.js draws content layers by depth, not by their stored order (gradient -3.2, noise field -3,
 * image -2.6, shape -2.5, text 0). The quad sits at -2.4: over every fill, under text, whatever the order of
 * mounting (a hidden and shown again ring is a new object, and object age must not decide what it covers).
 *
 * BLEND: the ring is light, so it always adds; the layer's blend mode is not applied, and the reader
 * stores "add" for it (../format).
 *
 * POINTER: the canvas takes no pointer events, so the ring leans through the engine's interactivity (the
 * window's pointer, smoothed). Without pointer settings it starts from `pointerBaseOf`: it follows fully with
 * the noise field's smoothing, a little calmer than the component's own 0.05 per frame lerp (only the moving
 * picture differs; the still frame has no lean). The engine's -1 to 1 is halved to the component's -0.5 to 0.5.
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { useInteractivity, useInteractivitySpec } from "../interactivity";
import { pointerBaseOf } from "../layerOps";
import {
  RING_FRAGMENT,
  RING_START_TIME,
  RING_VERTEX,
  buildRingParticles,
  mulberry32,
  ringGlowWeights,
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

/**
 * Shows the glow passes a glow asks for and gives each its strength (`ringGlowWeights`), in one step: pass `i` is
 * drawn when the glow has a weight for it, at that weight; a pass it has none for is hidden.
 */
export function applyGlowPasses(passes: readonly THREE.Points[], weights: readonly number[]): void {
  passes.forEach((points, i) => {
    const weight = weights[i] ?? 0;
    points.visible = weight > 0;
    ((points.material as THREE.RawShaderMaterial).uniforms.gain as { value: number }).value = weight;
  });
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
      // A glow pass's strength, the share of its points it draws (`ringGlowWeights`); the fine points do not read it.
      gain: { value: 1 },
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
 * as the only content layer the buffer already holds the background with the light summed onto it, exactly as the
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

/** The ring quad's depth: over every fill layer, under text (see ORDER above). */
const RING_DEPTH = -2.4;

/**
 * The scene's background as the display-space bytes the canvas shows, for a buffer that holds display-space
 * colour: read from the background three.js parsed (any colour the reader accepts), black when there is none.
 */
function backgroundBytes(background: unknown, into: THREE.Color): THREE.Color {
  if (!(background instanceof THREE.Color)) return into.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace);
  const srgb = background.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  return into.setRGB(srgb.r, srgb.g, srgb.b, THREE.LinearSRGBColorSpace);
}

function ParticleRingComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as RingValues;
  const interactivity = useInteractivity();
  // Without pointer settings of its own the ring leans as a first-time setting starts (layerOps
  // `pointerBaseOf`): fully, with the noise field's smoothing, so a first edit never makes it jump.
  const spec = useInteractivitySpec(layer.interactivity ?? pointerBaseOf(layer.type));
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(buildRingParticles(v.density, mulberry32(Math.round(v.seed))), 3));
    return g;
  }, [v.density, v.seed]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // One material per glow pass (two at most), so each carries its own strength.
  const glowMaterials = useMemo(() => [ringMaterial(1), ringMaterial(1)], []);
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
      for (const m of glowMaterials) m.dispose();
      coreMaterial.dispose();
      composite.dispose();
      target.dispose();
    },
    [glowMaterials, coreMaterial, composite, target],
  );

  // The points live in a scene of their own, drawn into the buffer before the frame; the layer's place in
  // the main scene is the full-box quad that adds the buffer.
  const ringScene = useMemo(() => new THREE.Scene(), []);
  // Both glow passes are always in the scene; each frame shows the ones the glow asks for and gives them their
  // strength in one step (`applyGlowPasses`), so a frame never draws the passes of one value with the strengths of
  // another (a jump from 0.5 to 2 would otherwise show one frame of glow 1).
  const glowPoints = useMemo(() => glowMaterials.map((m) => new THREE.Points(geometry, m)), [geometry, glowMaterials]);
  useEffect(() => {
    const objects = [...glowPoints, new THREE.Points(geometry, coreMaterial)];
    objects.forEach((o, i) => {
      o.frustumCulled = false;
      o.renderOrder = i;
      ringScene.add(o);
    });
    return () => {
      for (const o of objects) ringScene.remove(o);
    };
  }, [ringScene, geometry, glowPoints, coreMaterial]);

  const quad = useRef<THREE.Mesh | null>(null);
  useEffect(() => {
    ctx.registerObject(layer.id, quad.current);
    return () => ctx.registerObject(layer.id, null);
  }, [ctx, layer.id]);

  const bottom = ctx.bottomLayerId === layer.id;
  useEffect(() => setCompositeMode(composite, bottom), [composite, bottom]);

  const lean = useRef(new THREE.Vector2(0, 0));
  const drawing = useMemo(() => new THREE.Vector2(), []);
  const clear = useMemo(() => new THREE.Color(), []);
  const ground = useMemo(() => new THREE.Color(), []);
  useFrame((state) => {
    const t = ctx.reduce ? RING_START_TIME : RING_START_TIME + state.clock.elapsedTime * v.speed;
    interactivity.step(spec, ctx.reduce);
    // The engine's pointer runs -1 to 1 over the window; the component's lean runs -0.5 to 0.5 over its box.
    lean.current.set(interactivity.mouse.x * 0.5, interactivity.mouse.y * 0.5);
    const R = ringRadius(size.width, size.height);
    applyGlowPasses(glowPoints, ringGlowWeights(v.glow));
    for (const m of [...glowMaterials, coreMaterial]) {
      const u = m.uniforms;
      u.t.value = t;
      (u.res.value as THREE.Vector2).set(size.width, size.height);
      (u.ptr.value as THREE.Vector2).copy(lean.current);
      u.R.value = R;
      u.W.value = R * 0.2;
      u.dpr.value = dpr;
    }

    const gl = state.gl;
    // The buffer has exactly the canvas's pixels (the canvas rounds its size down, never to the nearest).
    gl.getDrawingBufferSize(drawing);
    const w = Math.max(1, drawing.x);
    const h = Math.max(1, drawing.y);
    if (target.width !== w || target.height !== h) target.setSize(w, h);
    const previousTarget = gl.getRenderTarget();
    const previousAlpha = gl.getClearAlpha();
    gl.getClearColor(clear);
    gl.setRenderTarget(target);
    // As the only content layer the light is summed onto the background itself (each sample clipped at full
    // brightness after the background, as on the component's canvas); over other layers onto nothing.
    if (bottom) gl.setClearColor(backgroundBytes(state.scene.background, ground), 1);
    else gl.setClearColor(0x000000, 0);
    gl.clear(true, false, false);
    gl.render(ringScene, state.camera);
    gl.setRenderTarget(previousTarget);
    gl.setClearColor(clear, previousAlpha);
  });

  return (
    <mesh ref={quad} material={composite} frustumCulled={false} position={[0, 0, RING_DEPTH]}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  );
}

export const ParticleRingLayer: LayerDefinition = {
  ...particleRingSchema,
  Component: ParticleRingComponent,
};
// ci-replay touch
