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
import { Fragment, useCallback, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import {
  Mesh,
  NoBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Blending,
  type Material,
  type Object3D,
  type Texture,
} from "three";

import { copyBlendState } from "./compositeBlend";
import type { PipelineGroup } from "../pipeline";
import { textureSize } from "../textureSize";

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

// uMode: 0 = the blend state weights by alpha (normal, add), 1 = screen and
// overlay, whose blend state ignores alpha: a pixel with no alpha at all adds
// nothing (an effect such as grain writes light into transparent pixels, which
// must not show), 2 = multiply: a pixel with no alpha leaves the picture as it is.
// Every other pixel is drawn as the layer itself would be.
const QUAD_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform float uMode;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    float seen = step(0.002, c.a);
    if (uMode > 1.5) c.rgb = mix(vec3(1.0), c.rgb, seen);
    else if (uMode > 0.5) c.rgb *= seen;
    gl_FragColor = c;
    // Same as the content layers: converts to the output colour space when
    // drawn to the screen, the identity when drawn into the main composer.
    #include <colorspace_fragment>
  }
`;

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

const world = new Vector3();

/** The depth a content root sits at: its first mesh's z in the scene (layers sit at a fixed z). */
function depthOf(root: Object3D): number {
  const mesh = meshesOf(root)[0];
  return mesh ? mesh.getWorldPosition(world).z : 0;
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

/**
 * A ref callback for a library `<EffectComposer>` that frees the composer when it is
 * replaced or gone (the library never does, and a composer holds two frame buffers).
 *
 * The callback is stable, so it runs only when the composer changes or goes away. In
 * development React StrictMode runs the library's layout effects twice on mount, which
 * clears the ref and sets it again for the SAME composer; freeing it at once would strip
 * its passes while it is still drawing. So a freeing is deferred one microtask and skipped
 * when the composer is back. (`dispose` also frees the geometry every pass shares; three.js
 * uploads it again on the next draw.)
 */
export function useHeldComposer(onChange?: (composer: ComposerImpl | null) => void): (composer: ComposerImpl | null) => void {
  const held = useRef<ComposerImpl | null>(null);
  return useCallback(
    (composer) => {
      onChange?.(composer);
      if (composer === null) {
        const gone = held.current;
        held.current = null;
        if (gone) {
          queueMicrotask(() => {
            if (held.current !== gone) gone.dispose();
          });
        }
        return;
      }
      const previous = held.current;
      held.current = composer;
      if (previous && previous !== composer) previous.dispose();
    },
    [onChange],
  );
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
  const holdComposer = useHeldComposer(
    useCallback((composer: ComposerImpl | null) => {
      composerRef.current = composer;
    }, []),
  );
  const failed = useRef(false);
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
  // A change of the target's blend reaches its material in that layer's own effect, after this
  // render. A scene drawn on demand (reduced motion) can draw the commit's frame before that effect
  // has run, so ask for another from an effect: it is drawn after the batch of this commit's effects.
  // (The scene's own RedrawOnChange does the same for every edit; this one keeps the group correct on its own.)
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    invalidate();
  }, [invalidate, group.target.blend]);
  useEffect(() => () => material.dispose(), [material]);
  const channel = group.channel;
  const targetId = group.target.id;
  const chain = group.effects;

  useFrame((_, delta) => {
    const composer = composerRef.current;
    const quad = quadRef.current;
    const root = roots.current.get(targetId);
    if (!composer || !quad || failed.current) return;
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
    const first = meshesOf(root)[0];
    // The quad draws with the blend its layer draws with, read before it is switched off below.
    if (first) material.uniforms.uMode.value = copyBlendState(materialsOf(first)[0], material);
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
    } catch (error) {
      // One layer's effects failing must not stop the picture: the layer is left out
      // from now on, said once, and the main picture is still drawn after this callback.
      failed.current = true;
      quad.visible = false;
      console.error(`[lumitra-fx] the effects of layer "${targetId}" could not be drawn and are left out:`, error);
      return;
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
      <EffectComposer
        ref={holdComposer}
        enabled={false} depthBuffer={false} multisampling={0}>
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
