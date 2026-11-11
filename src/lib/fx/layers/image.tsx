"use client";

/**
 * Image content layer (spec section 4 "Content/source layers / Image").
 *
 * Texture plane sized to the viewport with `cover` / `contain` fit, an
 * opacity knob, and an optional procedural displacement that nudges UVs by
 * a smoothed-mouse-driven noise field. The whole stack is a single
 * ShaderMaterial so the layer can use Phase 2's custom blend modes
 * (`applyContentBlend`) and the interactivity bus uniformly.
 *
 * Fit math runs in the fragment so the plane geometry stays a fixed-size
 * fullscreen quad: this avoids a per-frame `geometry.scale` walk and matches
 * how the noise-fill / gradient layers position themselves at z = -3.
 *
 * The `src` param is a URL string. We deliberately keep it as a leva color
 * field's cousin (a free-text string), so an editor user can paste any path
 * — but the Phase 2 demo only references files that already live in
 * `public/` so the build never fetches an external asset.
 */

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { imageSchema } from "../schemas";

interface ImageValues {
  src: string;
  fit: string;
  opacity: number;
  displace: number;
  scale: number;
}

interface ImageUniforms {
  [key: string]: THREE.IUniform<unknown>;
  uMap: THREE.IUniform<THREE.Texture | null>;
  uOpacity: THREE.IUniform<number>;
  uDisplace: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uMouse: THREE.IUniform<THREE.Vector2>;
  uPlaneAspect: THREE.IUniform<number>;
  uImageAspect: THREE.IUniform<number>;
  uFit: THREE.IUniform<number>; // 0 = cover, 1 = contain
  uScale: THREE.IUniform<number>;
}

const IMAGE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const IMAGE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uDisplace;
  uniform float uTime;
  uniform vec2 uMouse;
  uniform float uPlaneAspect;
  uniform float uImageAspect;
  uniform float uFit;
  uniform float uScale;
  varying vec2 vUv;

  // Compact 2D hash-noise; cheap and good enough for a UV nudge. We avoid the
  // big simplex implementation since this isn't asked to look textured, only
  // to bend the image slightly.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  // Compute "object-fit"-style UV mapping. Goal: map the plane's [0,1] UVs
  // to the texture's UVs so the image neither stretches nor pixelates.
  vec2 fitUv(vec2 uv, float planeA, float imgA, float fit) {
    vec2 scale = vec2(1.0);
    vec2 offset = vec2(0.0);
    // cover: scale axis = max(planeA / imgA, 1); contain: min.
    float ratio = imgA / planeA;
    if (fit < 0.5) {
      // cover
      if (ratio > 1.0) { scale.x = 1.0 / ratio; offset.x = 0.5 * (1.0 - scale.x); }
      else             { scale.y = ratio;         offset.y = 0.5 * (1.0 - scale.y); }
    } else {
      // contain
      if (ratio > 1.0) { scale.y = ratio;         offset.y = 0.5 * (1.0 - scale.y); }
      else             { scale.x = 1.0 / ratio;   offset.x = 0.5 * (1.0 - scale.x); }
    }
    return uv * scale + offset;
  }

  void main() {
    vec2 uv = vUv;
    uv = fitUv(uv, uPlaneAspect, uImageAspect, uFit);
    if (uDisplace > 0.0) {
      vec2 p = uv * 4.0 + uMouse * 0.5 + uTime * 0.06;
      vec2 d = vec2(vnoise(p), vnoise(p + 17.0)) - 0.5;
      uv += d * uDisplace;
    }
    // Clamp so cover/contain letterbox + displacement edge don't sample
    // garbage past [0, 1].
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0);
      return;
    }
    vec4 col = texture2D(uMap, uv);
    gl_FragColor = vec4(col.rgb, col.a * uOpacity);
  }
`;

const FIT_INDEX: Record<string, number> = { cover: 0, contain: 1 };

/**
 * Shared 1x1 fallback texture for when `src` is empty or fails to load.
 * Avoids a transient warning the first frame and gives the editor something
 * visible to drag/tune against.
 */
function createFallback(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 2;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function ImageLayerComponent({ layer, values, ctx }: LayerComponentProps) {
  const v = values as unknown as ImageValues;
  const matRef = useRef<THREE.ShaderMaterial | null>(null);
  // Imperative loader (instead of useLoader's Suspense throw): the engine
  // doesn't wrap layers in a Suspense boundary, and the fallback texture
  // gives us something to show while the network round-trips.
  const [fallback] = useState<THREE.Texture>(() => {
    const t = createFallback();
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
  // We deliberately store the loaded texture in a ref, not state: it's a
  // mutable Three resource (.colorSpace, .needsUpdate, .dispose), and the
  // project's react-hooks rules forbid mutating state values. A bump counter
  // triggers the re-bind effect when a new texture arrives.
  const texRef = useRef<THREE.Texture | null>(null);
  const [texVersion, setTexVersion] = useState(0);
  useEffect(() => {
    if (!v.src) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      v.src,
      (loaded) => {
        if (cancelled) {
          loaded.dispose();
          return;
        }
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.needsUpdate = true;
        // Dispose previous before adopting the new one to avoid GPU leaks
        // when the editor cycles `src` rapidly.
        texRef.current?.dispose();
        texRef.current = loaded;
        setTexVersion((n) => n + 1);
      },
      undefined,
      () => {
        // Silent fail: leave the fallback in place. A bad URL in the editor
        // shouldn't crash the whole canvas.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [v.src]);
  useEffect(
    () => () => {
      // Cleanup on unmount only. Disposes are owned by this component.
      texRef.current?.dispose();
      texRef.current = null;
      fallback.dispose();
    },
    [fallback],
  );
  const interactivity = useInteractivity();
  const spec = useInteractivitySpec(layer.interactivity);

  const initialUniforms = useMemo<ImageUniforms>(
    () => ({
      uMap: { value: null },
      uOpacity: { value: v.opacity },
      uDisplace: { value: v.displace },
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uPlaneAspect: { value: 26 / 16 },
      uImageAspect: { value: 1 },
      uFit: { value: FIT_INDEX[v.fit] ?? 0 },
      uScale: { value: v.scale },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    const loaded = texRef.current;
    const usable = loaded && loaded.image ? loaded : fallback;
    m.uniforms.uMap.value = usable;
    // three's Texture.image is typed as `{}` because it can be HTMLImageElement
    // / HTMLCanvasElement / ImageBitmap / VideoFrame; the width/height read is
    // the safe lowest common denominator across loader outputs.
    const img = usable.image as { width?: number; height?: number } | undefined;
    if (img && img.width && img.height) {
      m.uniforms.uImageAspect.value = img.width / img.height;
    }
  }, [texVersion, fallback]);

  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uOpacity.value = v.opacity;
  }, [v.opacity]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uDisplace.value = v.displace;
  }, [v.displace]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uFit.value = FIT_INDEX[v.fit] ?? 0;
  }, [v.fit]);
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uScale.value = v.scale;
  }, [v.scale]);
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

  const planeW = 26 * v.scale;
  const planeH = 16 * v.scale;

  return (
    <mesh position={[0, 0, -2.6]} scale={[1, 1, 1]}>
      <planeGeometry args={[planeW, planeH]} />
      <shaderMaterial
        ref={(m) => {
          matRef.current = m;
          if (m) applyContentBlend(m, layer.blend);
        }}
        uniforms={initialUniforms}
        vertexShader={IMAGE_VERT}
        fragmentShader={IMAGE_FRAG}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

export const ImageLayer: LayerDefinition = {
  ...imageSchema,
  Component: ImageLayerComponent,
};
