"use client";

/**
 * Effects that apply to one content layer only (`Layer.target`).
 *
 * Mounted by LumitraScene ONLY when the plan has groups; a scene without
 * `target` never reaches this file.
 *
 * How one group is drawn, every frame:
 *   1. the target's object lives on its own three.js layer channel (1 to 4), so
 *      the main camera (channel 0) does not draw it;
 *   2. a composer of its own draws that channel, with the target's materials
 *      switched to plain (unblended) colour plus alpha, into a transparent
 *      buffer, and runs the group's effects over it in stored order;
 *   3. a quad in the main scene draws the result in the layer's place, with
 *      the layer's own blend mode, and the main picture goes on as before.
 *
 * Order of work inside a frame (r3f runs callbacks by ascending priority):
 *   layers animate in their own callbacks (priority 0), the groups render at
 *   GROUP_PRIORITY, and the main picture is drawn at MAIN_PRIORITY.
 */

import { EffectComposer } from "@react-three/postprocessing";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer as ComposerImpl, RenderPass } from "postprocessing";
import { Fragment, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import {
  Mesh,
  NoBlending,
  ShaderMaterial,
  Vector2,
  type Blending,
  type Material,
  type Object3D,
  type Texture,
} from "three";

import { applyContentBlend } from "../layers/contentBlend";
import type { PipelineGroup } from "../pipeline";
import { textureSize } from "../textureSize";
import type { BlendMode } from "../types";

/** Groups render after every layer has animated, before the main picture. */
export const GROUP_PRIORITY = 1;
/** The main picture, once the groups are drawn. */
export const MAIN_PRIORITY = 2;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// uMode: 0 = alpha blending (the blend state weights by alpha), 1 = colour is
// weighted by alpha here (add, screen, overlay: light written into transparent
// pixels by an effect must not show), 2 = multiply (transparent leaves white).
const QUAD_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform float uMode;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    if (uMode > 1.5) c.rgb = mix(vec3(1.0), c.rgb, c.a);
    else if (uMode > 0.5) c.rgb *= c.a;
    gl_FragColor = c;
    // Same as the content layers: converts to the output colour space when
    // drawn to the screen, the identity when drawn into the main composer.
    #include <colorspace_fragment>
  }
`;

function modeOf(blend: BlendMode): number {
  if (blend === "normal") return 0;
  return blend === "multiply" ? 2 : 1;
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Put an object and everything under it on one channel (masks are per object, not inherited). */
export function setChannel(root: Object3D, channel: number): void {
  root.traverse((o) => o.layers.set(channel));
}

/** The depth a content root sits at: its first mesh's z (layers sit at a fixed z). */
function depthOf(root: Object3D): number {
  return meshesOf(root)[0]?.position.z ?? 0;
}

/**
 * Give every content root a render order that reproduces the order the scene
 * draws them in on its own: back (smaller z) to front, stored order on a tie.
 * Without it two layers at the same z would be ordered by object age, and the
 * composite quad is the youngest object.
 */
export function rankRoots(roots: ReadonlyMap<string, Object3D>, order: readonly string[]): Map<string, number> {
  const entries = order
    .map((id, index) => ({ id, index, z: roots.get(id) ? depthOf(roots.get(id)!) : null }))
    .filter((e): e is { id: string; index: number; z: number } => e.z !== null)
    .sort((a, b) => a.z - b.z || a.index - b.index);
  const ranks = new Map<string, number>();
  entries.forEach((e, i) => ranks.set(e.id, i));
  for (const [id, rank] of ranks) {
    roots.get(id)!.traverse((o) => {
      o.renderOrder = rank;
    });
  }
  return ranks;
}

/**
 * The buffer holding a composer's finished picture when no pass draws to the
 * screen. The composer swaps its buffers in local variables only, once per
 * enabled pass that needs a swap, so an odd count leaves the picture in the
 * output buffer.
 */
export function resultOf(composer: ComposerImpl): Texture {
  const swaps = composer.passes.filter((pass) => pass.enabled && pass.needsSwap).length;
  return (swaps % 2 === 1 ? composer.outputBuffer : composer.inputBuffer).texture;
}

interface ScopedGroupProps {
  group: PipelineGroup;
  /** The wrapper object of every drawn content layer, by layer id (filled by LumitraScene). */
  roots: MutableRefObject<Map<string, Object3D>>;
  /** The drawn content layers' ids in stored order. */
  order: readonly string[];
  /** Renders one effect layer's component. */
  renderLayer: (layerId: string) => ReactNode;
}

export function ScopedGroup({ group, roots, order, renderLayer }: ScopedGroupProps) {
  const { gl, camera } = useThree();
  const composerRef = useRef<ComposerImpl | null>(null);
  const quadRef = useRef<Mesh>(null);
  const drawingSize = useMemo(() => new Vector2(), []);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: QUAD_FRAG,
        uniforms: { uMap: { value: null }, uMode: { value: 0 } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => {
    applyContentBlend(material, group.target.blend);
    material.uniforms.uMode.value = modeOf(group.target.blend);
    material.needsUpdate = true;
  }, [material, group.target.blend]);
  useEffect(() => () => material.dispose(), [material]);
  // The library never disposes its composer: free the buffers when the group goes.
  useEffect(
    () => () => {
      composerRef.current?.dispose();
      composerRef.current = null;
    },
    [],
  );

  const channel = group.channel;
  const targetId = group.target.id;
  const chain = group.effects;

  useFrame((_, delta) => {
    const composer = composerRef.current;
    const quad = quadRef.current;
    const root = roots.current.get(targetId);
    if (!composer || !quad) return;
    if (!root) {
      quad.visible = false;
      return;
    }
    setChannel(root, channel); // idempotent: covers children a layer adds later
    const ranks = rankRoots(roots.current, order);
    quad.renderOrder = ranks.get(targetId) ?? 0;
    quad.position.z = depthOf(root);

    // Buffers follow the drawing buffer, capped (see ../textureSize). The
    // library resets them to the full size on every resize, so compare the real size.
    gl.getDrawingBufferSize(drawingSize);
    const size = textureSize(drawingSize.x, drawingSize.y);
    if (composer.inputBuffer.width !== size.width || composer.inputBuffer.height !== size.height) {
      composer.inputBuffer.setSize(size.width, size.height);
      composer.outputBuffer.setSize(size.width, size.height);
      for (const pass of composer.passes) pass.setSize(size.width, size.height);
    }

    // The picture stays in a buffer, and its background is transparent.
    composer.autoRenderToScreen = false;
    for (const pass of composer.passes) {
      pass.renderToScreen = false;
      if (pass instanceof RenderPass) pass.ignoreBackground = true;
    }

    // Draw the layer as plain colour plus alpha: its own blend mode is applied
    // when the result is composited, and multiply against an empty buffer is black.
    const saved: Array<[Material, Blending]> = [];
    for (const mesh of meshesOf(root)) {
      for (const m of materialsOf(mesh)) {
        saved.push([m, m.blending]);
        m.blending = NoBlending;
      }
    }
    const mask = camera.layers.mask;
    const autoClear = gl.autoClear;
    camera.layers.set(channel);
    gl.autoClear = true;
    try {
      composer.render(delta);
    } finally {
      gl.autoClear = autoClear;
      camera.layers.mask = mask;
      gl.setRenderTarget(null);
      for (const [m, blending] of saved) m.blending = blending;
    }
    material.uniforms.uMap.value = resultOf(composer);
    quad.visible = true;
  }, GROUP_PRIORITY);

  return (
    <>
      <EffectComposer ref={composerRef} enabled={false} depthBuffer={false} multisampling={0}>
        {chain.map((layer) => (
          <Fragment key={layer.id}>{renderLayer(layer.id)}</Fragment>
        ))}
      </EffectComposer>
      <mesh ref={quadRef} material={material} frustumCulled={false} visible={false}>
        <planeGeometry args={[2, 2]} />
      </mesh>
    </>
  );
}

/**
 * Draws the main picture itself, after the groups. r3f draws it on its own only
 * while no callback has a positive priority, and the groups have one. Mounted
 * only when the scene has groups and no main composer (which draws it itself).
 */
export function MainRender() {
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera);
  }, MAIN_PRIORITY);
  return null;
}
