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
 * Under prefers-reduced-motion the scene is one still frame: layers pin their
 * clocks (`ctx.reduce`) and the canvas draws on demand instead of every frame.
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

import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer } from "@react-three/postprocessing";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Object3D } from "three";

import { planPipeline } from "./pipeline";
import { MAIN_PRIORITY, MainRender, ScopedGroup, setChannel } from "./effects/ScopedGroup";
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
  /**
   * Called once, when the first frame has been drawn. A host that fades the
   * scene in waits for this, so it never fades in an empty canvas.
   */
  onFirstFrame?: () => void;
  /**
   * Called once when the scene cannot draw (any more): no WebGL context could
   * be created, the renderer threw while it was set up, or the context was
   * lost. A host that shows its own background instead removes the scene then.
   */
  onFail?: (reason: SceneFailure) => void;
  /**
   * Size the canvas from its container's layout size (`offsetWidth`, `offsetHeight`)
   * instead of its rectangle on screen. A host that is scaled by a CSS transform (an
   * editor canvas at a zoom) sets this: the rectangle is the scaled size there, and
   * a canvas sized from it is drawn too large or too small inside the same transform.
   */
  layoutSize?: boolean;
}

/** The canvas measured by its layout size, see `layoutSize`. */
const LAYOUT_SIZE = { offsetSize: true } as const;

/** Why a scene stopped drawing, see `onFail`. */
export type SceneFailure = "no-webgl" | "renderer-error" | "context-lost";

/** Inside the Canvas: reports once that a frame has been drawn. */
function FirstFrame({ onFirstFrame }: { onFirstFrame: () => void }) {
  const seen = useRef(false);
  const pending = useRef<number | null>(null);
  // A frame callback runs before its frame is drawn, so the report waits for
  // the next animation frame. Not for the next frame callback: a scene held
  // still (reduced motion) draws on demand and may never have a second one.
  useFrame(() => {
    if (seen.current) return;
    seen.current = true;
    pending.current = requestAnimationFrame(() => {
      pending.current = null;
      onFirstFrame();
    });
  });
  useEffect(
    () => () => {
      if (pending.current !== null) cancelAnimationFrame(pending.current);
    },
    [],
  );
  return null;
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

export function LumitraScene({ config, className, fallback, onFirstFrame, onFail, layoutSize = false }: LumitraSceneProps) {
  const [objects, setObjects] = useState<Record<string, Object3D>>({});
  const reduce = useMemo(() => readPrefersReducedMotion(), []);

  // WebGL capability gate. If the GPU can't hand us a context (crashed/wedged
  // process, locked-down browser), render `fallback` instead of mounting the
  // Canvas so the page degrades gracefully instead of throwing.
  const [webglOk, setWebglOk] = useState<boolean>(() => detectWebGL());
  // Why WebGL is not (or no longer) available; the probe failing is the default.
  const failure = useRef<SceneFailure>("no-webgl");
  const reported = useRef(false);
  const fail = useCallback((reason: SceneFailure) => {
    failure.current = reason;
    setWebglOk(false);
  }, []);
  useEffect(() => {
    if (webglOk || reported.current) return;
    reported.current = true;
    onFail?.(failure.current);
  }, [webglOk, onFail]);

  // Performance downshift state (sticky). Initialized true on mobile-class
  // pointers so we don't pay the "decline -> downshift" cost on devices that
  // were never going to clear the 60fps bar anyway.
  const [perfLow, setPerfLow] = useState<boolean>(() => isMobileLikely());

  // A content layer hands over its object through a ref callback written
  // inline, so React calls it with `null` and then with the same object again
  // on EVERY render of that layer. Taking the `null` at once changed the
  // registry (a new object each time), which re-rendered the scene, which
  // called the refs again: an endless render loop, hidden only because the
  // scene redraws every frame anyway. A removal therefore waits one microtask
  // and is dropped when the same id is registered again in the meantime; only
  // a layer that really unmounted is removed.
  const pendingRemovals = useRef(new Set<string>());
  const registerObject = useCallback((id: string, obj: Object3D | null) => {
    if (obj === null) {
      pendingRemovals.current.add(id);
      queueMicrotask(() => {
        if (!pendingRemovals.current.delete(id)) return;
        setObjects((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      });
      return;
    }
    pendingRemovals.current.delete(id);
    setObjects((prev) => (prev[id] === obj ? prev : { ...prev, [id]: obj }));
  }, []);

  const ctx: LayerContext = useMemo(
    () => ({
      registerObject,
      getObject: (id: string) => objects[id] ?? null,
      reduce,
    }),
    [registerObject, objects, reduce],
  );

  // What to draw: visible layers, minus the heavy ones after the step down,
  // minus post passes whose source layer is not drawn (see ./pipeline).
  const { content: contentLayers, post: postLayers, postReady, groups } = planPipeline(
    config.layers,
    perfLow,
    (layerId) => objects[layerId] != null,
  );

  // Content layers by id for the groups (only read when `groups` is not empty).
  const roots = useRef(new Map<string, Object3D>());
  const channelOf = new Map(groups.map((g) => [g.target.id, g.channel]));
  const mainComposer = postReady && postLayers.length > 0;
  const layerById = new Map(config.layers.map((l) => [l.id, l]));

  const dprClamp = perfLow ? ([1, 1] as [number, number]) : config.dpr;

  return (
    <div
      className={className}
      style={{ position: "absolute", inset: 0, background: config.background }}
    >
      {webglOk ? (
        <WebGLErrorBoundary onError={() => fail("renderer-error")}>
          <Canvas
            dpr={dprClamp}
            resize={layoutSize ? LAYOUT_SIZE : undefined}
            // Reduced motion means one still frame. Every layer already pins its
            // own clock under `reduce`, but a post pass with a clock of its own
            // (the grain's noise is new on every frame) kept the picture moving.
            // Drawing on demand settles it: a frame is drawn when the scene or
            // its size changes, and never otherwise.
            frameloop={reduce ? "demand" : "always"}
            // The scene is a background: it takes no click, tap or hover, and
            // what is under it stays reachable. Layers that follow the pointer
            // listen on the window (./interactivity), not on the canvas.
            style={{ pointerEvents: "none" }}
            gl={{ antialias: true, powerPreference: "high-performance" }}
            camera={{ position: [0, 0, 5], fov: 50 }}
            onCreated={({ gl }) => {
              // If the GPU process dies mid-session, fall back instead of
              // freezing on a black canvas.
              gl.domElement.addEventListener(
                "webglcontextlost",
                (e) => {
                  e.preventDefault();
                  fail("context-lost");
                },
                { once: true },
              );
            }}
          >
            {/* Once the step down happened it is final, so the monitor
                has nothing left to report and is unmounted. */}
            {!perfLow && <FrameRateMonitor onDecline={() => setPerfLow(true)} />}
            {onFirstFrame && <FirstFrame onFirstFrame={onFirstFrame} />}
            <color attach="background" args={[config.background]} />
            {contentLayers.map((layer) =>
              groups.length === 0 ? (
                <LayerHost key={layer.id} layer={layer} ctx={ctx} />
              ) : (
                <ScopedRoot key={layer.id} layer={layer} ctx={ctx} roots={roots} channel={channelOf.get(layer.id)} />
              ),
            )}
            {/* Only when the scene has targeted effects: each group draws itself and its
                effects in its own composer, and the main picture is drawn after them. */}
            {groups.map((group) => (
              <ScopedGroup
                key={group.target.id}
                group={group}
                roots={roots}
                order={contentLayers.map((l) => l.id)}
                renderLayer={(id) => {
                  const layer = layerById.get(id);
                  return layer ? <LayerHost layer={layer} ctx={ctx} /> : null;
                }}
              />
            ))}
            {groups.length > 0 && !mainComposer && <MainRender />}
            {mainComposer && (
              <EffectComposer multisampling={0} renderPriority={groups.length > 0 ? MAIN_PRIORITY : undefined}>
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

/**
 * A content layer of a scene that has targeted effects: held in a group so its
 * object (and everything under it) can be moved to the group's channel, and
 * given a render order. The group only exists in scenes with targeted effects.
 */
function ScopedRoot({
  layer,
  ctx,
  roots,
  channel,
}: {
  layer: Layer;
  ctx: LayerContext;
  roots: { current: Map<string, Object3D> };
  channel: number | undefined;
}) {
  return (
    <group
      ref={(g) => {
        if (!g) {
          roots.current.delete(layer.id);
          return;
        }
        roots.current.set(layer.id, g);
        setChannel(g, channel ?? 0);
      }}
    >
      <LayerHost layer={layer} ctx={ctx} />
    </group>
  );
}
