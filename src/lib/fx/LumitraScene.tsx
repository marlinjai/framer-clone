"use client";

/**
 * <LumitraScene config={SceneConfig} />
 *
 * The engine entry point. Owns a single r3f Canvas, a single EffectComposer,
 * and a small object registry so post layers can bind to content meshes by id.
 *
 * Pipeline:
 *   content layers (back -> front, rendered as meshes)
 *   post layers    (top of the layer list to bottom = composer pass order)
 *
 * `config` is controlled: the scene renders exactly the config it is handed
 * and re-renders when the parent passes a new one. In lumitra-web (source
 * commit 8a77254) the component also mounted a leva tuning panel behind
 * `?tune=1` and therefore owned a copy of the config; Lumitra Sites edits a
 * scene in its own properties panel, so that panel, its localStorage autosave
 * and the leva dependency are not part of this copy.
 *
 * A `FrameRateMonitor` inside the Canvas watches the frame rate. When it stays
 * below the floor (see ./frameRate), a sticky `perfLow` flag is set and routed
 * two ways:
 *   - dpr is clamped to [1, 1] (drop the pixel budget by up to 3x)
 *   - layers marked `heavy` in the registry are dropped from the pipeline
 * The downshift is sticky for the lifetime of the canvas; we don't try to
 * upshift on a brief recovery because that produces a visible jank cycle.
 *
 * WebGL guard (spec section 8): a context can be impossible to create on a
 * locked-down/old browser or, in dev, a crashed/wedged GPU process. We
 * pre-flight `detectWebGL` and render `fallback` instead of mounting the
 * Canvas if it fails, so the page degrades to a static frame rather than
 * throwing an unhandled rejection / error overlay. A `WebGLErrorBoundary` and
 * a `webglcontextlost` listener cover the cases where the context dies after
 * the probe passed (e.g. the GPU process crashes mid-session).
 */

import { Canvas } from "@react-three/fiber";
import { EffectComposer } from "@react-three/postprocessing";
import { Component, useCallback, useMemo, useState, type ReactNode } from "react";
import type { Object3D } from "three";

import { getLayerDefinition } from "./registry";
import { FrameRateMonitor } from "./FrameRateMonitor";
import type {
  Layer,
  LayerContext,
  ParamSchema,
  ParamValues,
  ParamsSchema,
  SceneConfig,
} from "./types";

// Side effect: register all built-in layers on first import of the scene.
import "./builtins";

interface LumitraSceneProps {
  config: SceneConfig;
  className?: string;
  /**
   * Rendered in place of the Canvas when WebGL is unavailable (locked-down or
   * old browsers, or a crashed/wedged GPU process). The scene background is
   * always painted underneath, so the hero never flashes a transparent box.
   * When omitted, the fallback is just that background frame.
   */
  fallback?: ReactNode;
}

function extractValues<P extends ParamsSchema>(params: P): ParamValues<P> {
  const out = {} as Record<string, ParamSchema["value"]>;
  for (const [k, schema] of Object.entries(params)) {
    out[k] = schema.value;
  }
  return out as ParamValues<P>;
}

function readPrefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Coarse-pointer (touch) heuristic. We don't ship Fluid on phones, and we
 * pre-clamp the dpr cap there even before PerformanceMonitor fires. Same
 * predicate Tailwind / drei use; safe in SSR (returns false).
 */
function isMobileLikely(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/**
 * One-shot WebGL capability probe. Returns false when no context can be
 * created (GPU disabled/crashed, software rendering off, ancient browser). We
 * create a throwaway context and immediately release it so the probe itself
 * doesn't hold a slot against the browser's WebGL context cap.
 */
function detectWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ||
      canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Backstop for the synchronous throw r3f raises when WebGLRenderer
 * construction fails (probe passed but creation still failed). Renders nothing
 * on failure and notifies the parent, which swaps in the fallback.
 */
class WebGLErrorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function LumitraScene({ config, className, fallback }: LumitraSceneProps) {
  const [objects, setObjects] = useState<Record<string, Object3D>>({});
  const reduce = useMemo(() => readPrefersReducedMotion(), []);

  // WebGL capability gate. If the GPU can't hand us a context (crashed/wedged
  // process, locked-down browser), render `fallback` instead of mounting the
  // Canvas so the page degrades gracefully instead of throwing.
  const [webglOk, setWebglOk] = useState<boolean>(() => detectWebGL());

  // Performance downshift state (sticky). Initialized true on mobile-class
  // pointers so we don't pay the "decline -> downshift" cost on devices that
  // were never going to clear the 60fps bar anyway.
  const [perfLow, setPerfLow] = useState<boolean>(() => isMobileLikely());

  const registerObject = useCallback((id: string, obj: Object3D | null) => {
    setObjects((prev) => {
      if (obj === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      if (prev[id] === obj) return prev;
      return { ...prev, [id]: obj };
    });
  }, []);

  const ctx: LayerContext = useMemo(
    () => ({
      registerObject,
      getObject: (id: string) => objects[id] ?? null,
      reduce,
    }),
    [registerObject, objects, reduce],
  );

  // Apply the perf downshift: drop heavy layers and clamp dpr to 1. Layers
  // are filtered before kind splitting so the visibility / kind logic stays
  // ignorant of perf state.
  const liveLayers = useMemo(() => {
    if (!perfLow) return config.layers;
    return config.layers.filter((l) => !getLayerDefinition(l.type)?.heavy);
  }, [config.layers, perfLow]);

  const dprClamp = perfLow ? ([1, 1] as [number, number]) : config.dpr;

  const visibleLayers = liveLayers.filter((l) => l.visible);
  const contentLayers = visibleLayers.filter(
    (l) => getLayerDefinition(l.type)?.kind === "content",
  );
  const postLayers = visibleLayers.filter(
    (l) => getLayerDefinition(l.type)?.kind === "post",
  );

  // Mirror v7's `{sun && <Effects/>}` gate: if any post layer references a
  // source content layer that isn't mounted yet, hold the composer off until
  // it is. Avoids a transient frame where GodRays runs against null.
  const postReady = postLayers.every((layer) => {
    const src = layer.params.sourceLayerId as ParamSchema | undefined;
    if (!src || src.type !== "select") return true;
    return objects[src.value] != null;
  });

  return (
    <div
      className={className}
      style={{ position: "absolute", inset: 0, background: config.background }}
    >
      {webglOk ? (
        <WebGLErrorBoundary onError={() => setWebglOk(false)}>
          <Canvas
            dpr={dprClamp}
            gl={{ antialias: true, powerPreference: "high-performance" }}
            camera={{ position: [0, 0, 5], fov: 50 }}
            onCreated={({ gl }) => {
              // If the GPU process dies mid-session, fall back instead of
              // freezing on a black canvas.
              gl.domElement.addEventListener(
                "webglcontextlost",
                (e) => {
                  e.preventDefault();
                  setWebglOk(false);
                },
                { once: true },
              );
            }}
          >
            {/* Once the step down happened it is final, so the monitor
                has nothing left to report and is unmounted. */}
            {!perfLow && <FrameRateMonitor onDecline={() => setPerfLow(true)} />}
            <color attach="background" args={[config.background]} />
            {contentLayers.map((layer) => (
              <LayerHost key={layer.id} layer={layer} ctx={ctx} />
            ))}
            {postReady && postLayers.length > 0 && (
              <EffectComposer multisampling={0}>
                {postLayers.map((layer) => (
                  <LayerHost key={layer.id} layer={layer} ctx={ctx} />
                ))}
              </EffectComposer>
            )}
          </Canvas>
        </WebGLErrorBoundary>
      ) : (
        <div aria-hidden style={{ position: "absolute", inset: 0 }}>
          {fallback}
        </div>
      )}
    </div>
  );
}

function LayerHost({ layer, ctx }: { layer: Layer; ctx: LayerContext }) {
  const def = getLayerDefinition(layer.type);
  if (!def) return null;
  const values = extractValues(layer.params);
  const Component = def.Component;
  return <Component layer={layer} values={values} ctx={ctx} />;
}
