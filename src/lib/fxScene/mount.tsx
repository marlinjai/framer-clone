// src/lib/fxScene/mount.tsx
//
// Draws one FX scene. This file and everything it imports (the engine with
// three.js, the strict reader with the layer schemas) is ONE lazy chunk, reached
// by a dynamic import only, only where a scene will really be drawn, only once
// WebGL is known to work: by the published page's island (FxIsland) and by the
// editor's layer for its canvas and its preview (src/components/fx/FxLayer.tsx).
// Nothing else may import it (asserted in src/lib/fx/__tests__/boundaryGuard.test.ts).
//
// The scene is read through the strict reader a second time here, on the client,
// so what is drawn never depends on the caller having checked it.
//
// Two ways in:
//
//  - `renderFxScene` draws into a layer the caller already has, and hands back an
//    `update` for a changed scene (the editor's canvas, where every change in the
//    panel shows at once in the one context) and a `teardown`.
//  - `renderFxStill` draws ONE still frame (the reduced-motion frame) at the size of a
//    box, in one shared renderer out of sight whose context is kept between still
//    frames and released soon after the last, and copies the picture into a plain 2D
//    canvas: the editor's still frames of a scene in the breakpoint frames it is not
//    drawn live in (src/components/fx/FxLayer.tsx).
//  - `mountFxScene` is the published page's: it makes the layer itself, as the
//    box's first child (./box.ts says how it sits there), fades it in on the first
//    frame, and takes it out again when the scene cannot draw (or stops), so the
//    box is exactly what the server sent.
"use client";

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LumitraScene, type SceneFailure, type SceneProbe } from "@/lib/fx";
import type { SceneConfig } from "@/lib/fx/format";
import { FX_FADE_MS, FX_LAYER_STYLE, holdFxBox } from "./box";
import { parseFxProp } from "./fxScene";
import { FX_LAYER_ATTR } from "./marker";

export { FX_FADE_MS };

/** Why nothing is drawn: the engine's own reasons, or a scene the strict reader refused. */
export type FxOffReason = SceneFailure | "refused";

export interface RenderFxOptions {
  /** The first frame is drawn. Called again after a refused scene was replaced by one that draws. */
  onLive: () => void;
  /** The scene cannot be drawn, or stopped. Nothing of it is left in the layer. */
  onOff: (reason: FxOffReason) => void;
  /**
   * Where a stored image address is fetched from on this surface. The scene stores
   * a site path (`/site-images/<sha256>.<ext>`), which the published site serves as
   * it is; the editor serves the same picture from its own address, behind sign-in.
   * Applied AFTER the strict read, which accepts site paths only. Returning null
   * draws the layer without a picture.
   */
  resolveImage?: (src: string) => string | null;
  /**
   * Size the canvas from the layer's layout size, not from its rectangle on screen.
   * For a surface that is scaled by a CSS transform (the editor's zoomed canvas),
   * where the rectangle is the scaled size and the canvas would be drawn too large.
   */
  layoutSize?: boolean;
  /**
   * The editor's canvas only: receives what picking a layer needs while the context lives
   * (`null` when it goes). Fixed for the life of the root: it changes how the scene is held.
   */
  onProbe?: (probe: SceneProbe | null) => void;
}

export interface FxSceneHandle {
  /** Draw this scene instead, in the same context. A refused scene clears the layer and reports `refused`. */
  update: (stored: unknown) => void;
  /** Stop drawing and release the WebGL context. Safe to call more than once. */
  teardown: () => void;
}

/** The scene with every image address as this surface fetches it. */
function withResolvedImages(
  scene: SceneConfig,
  resolveImage: RenderFxOptions["resolveImage"],
): SceneConfig {
  if (!resolveImage) return scene;
  let changed = false;
  const layers = scene.layers.map((layer) => {
    const src = layer.type === "image" ? layer.params.src : undefined;
    if (!src || src.type !== "string" || src.value === "") return layer;
    const resolved = resolveImage(src.value) ?? "";
    if (resolved === src.value) return layer;
    changed = true;
    return {
      ...layer,
      params: { ...layer.params, src: { ...src, value: resolved } },
    };
  });
  return changed ? { ...scene, layers } : scene;
}

/** Ask the browser to free the WebGL context of every canvas in `layer` now. Never throws: the unmount that follows disposes the rest. */
function loseContexts(layer: HTMLElement): void {
  for (const canvas of layer.querySelectorAll("canvas")) {
    try {
      const gl = (canvas.getContext("webgl2") ??
        canvas.getContext("webgl")) as WebGLRenderingContext | null;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // The context is gone or cannot be asked: nothing to release.
    }
  }
}

/** Draw `stored` into `layer`, which the caller owns and has placed. */
export function renderFxScene(
  layer: HTMLElement,
  stored: unknown,
  { onLive, onOff, resolveImage, layoutSize, onProbe }: RenderFxOptions,
): FxSceneHandle {
  let root: Root | null = null;
  let done = false;
  // One per root: a scene that failed is not drawn again by a later update of the same root.
  let failed = false;
  // Whether the current root has drawn its first frame.
  let firstFrame = false;

  const unmount = () => {
    // Unmounting alone leaves the context to be lost a moment later (react-three-fiber defers it by 500 ms),
    // long enough for the next element's scene to start beside it. Release it here, before the root goes.
    if (root) loseContexts(layer);
    root?.unmount();
    root = null;
  };

  const draw = (value: unknown) => {
    if (done || failed) return;
    const parsed = parseFxProp(value);
    if (!parsed.ok) {
      unmount();
      onOff("refused");
      return;
    }
    if (root === null) {
      root = createRoot(layer);
      firstFrame = false;
    }
    const drawing = root;
    root.render(
      createElement(LumitraScene, {
        config: withResolvedImages(parsed.fx.scene, resolveImage),
        layoutSize,
        onProbe,
        // Asked for until it came: an update that arrives before the first frame must not lose it.
        ...(firstFrame
          ? {}
          : {
              onFirstFrame: () => {
                if (done || root !== drawing || firstFrame) return;
                firstFrame = true;
                onLive();
              },
            }),
        onFail: (reason: SceneFailure) => {
          if (done || root !== drawing) return;
          failed = true;
          // Not inside React's own commit: unmounting a root from its effect is refused.
          queueMicrotask(() => {
            if (done) return;
            unmount();
            onOff(reason);
          });
        },
      }),
    );
  };

  draw(stored);

  return {
    update: draw,
    teardown: () => {
      if (done) return;
      done = true;
      unmount();
    },
  };
}

/** How long a still frame waits for another frame (a late image or font) before its picture counts. */
export const FX_STILL_SETTLE_MS = 250;
/** The longest a still frame is waited for, from the first frame: a scene that keeps drawing is taken as it is then. */
export const FX_STILL_MAX_MS = 3000;
/** The longest a still frame waits for its first frame: a scene that never draws one is given up as `empty`. */
export const FX_STILL_FIRST_FRAME_MS = 15000;
/**
 * How long the still renderer keeps its context once no still frame is asked for. Setting a scene up in a
 * context (compiling its shaders, building its layers) is one long task on the main thread, measured at about
 * 340 ms for the gold preset on a laptop; the frames of one breakpoint row ask one after the other, so the
 * context is kept between them and only the first pays it.
 */
export const FX_STILL_RELEASE_MS = 4000;

export interface RenderFxStillOptions {
  /** As for `renderFxScene`. */
  resolveImage?: (src: string) => string | null;
  /** The pixel ratio to draw at (the caller bounds it); replaces the scene's own range. */
  pixelRatio: number;
  /** Aborted: the job is given up at once and the promise rejects with `aborted`. */
  signal: AbortSignal;
}

/** Why a still frame was not made: the live scene's reasons, and `aborted`, `empty` and `no-host`. */
export type FxStillFailure = FxOffReason | "aborted" | "empty" | "no-host";

interface StillJob {
  width: number;
  height: number;
  pixelRatio: number;
  onFrame: () => void;
  onFail: (reason: SceneFailure) => void;
}

/**
 * The one renderer every still frame of the editor is drawn by: a hidden host out of sight, sized as the box a
 * still is for, with one React root and one WebGL context that are kept while still frames are asked for and
 * released FX_STILL_RELEASE_MS after the last. Still frames are made one at a time (src/lib/fxScene/stillQueue.ts),
 * so one job owns it at a time.
 */
let stillRenderer: {
  host: HTMLDivElement;
  root: Root;
  job: StillJob | null;
  release?: number;
} | null = null;

function dropStillRenderer(): void {
  const renderer = stillRenderer;
  if (!renderer) return;
  stillRenderer = null;
  if (renderer.release !== undefined) window.clearTimeout(renderer.release);
  // Not inside React's own commit: unmounting a root from its effect is refused.
  queueMicrotask(() => {
    loseContexts(renderer.host);
    renderer.root.unmount();
    renderer.host.remove();
  });
}

function stillRendererFor(
  job: StillJob,
  scene: SceneConfig,
): NonNullable<typeof stillRenderer> {
  if (!stillRenderer) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    // Laid out (so the canvas takes its size) but out of sight and out of the way.
    Object.assign(host.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      pointerEvents: "none",
      contain: "strict",
      overflow: "hidden",
    });
    document.body.appendChild(host);
    stillRenderer = { host, root: createRoot(host), job: null };
  }
  const renderer = stillRenderer;
  if (renderer.release !== undefined) window.clearTimeout(renderer.release);
  renderer.release = undefined;
  renderer.job = job;
  Object.assign(renderer.host.style, {
    width: `${job.width}px`,
    height: `${job.height}px`,
  });
  // The same scene keeps its layers (and their shaders); a new config object asks for a frame.
  const draw = () =>
    renderer.root.render(
      createElement(LumitraScene, {
        config: { ...scene, dpr: [job.pixelRatio, job.pixelRatio] },
        layoutSize: true,
        still: true,
        onFrame: () => renderer.job?.onFrame(),
        onFail: (reason: SceneFailure) => {
          const failed = renderer.job;
          // A context that failed is not drawn in again: the next still frame starts a new one.
          dropStillRenderer();
          failed?.onFail(reason);
        },
      }),
    );
  draw();
  // Once the canvas has measured the host's new size (two frames on), one more frame at that size.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (stillRenderer === renderer && renderer.job === job) draw();
    }),
  );
  return renderer;
}

function releaseStillRendererLater(): void {
  const renderer = stillRenderer;
  if (!renderer) return;
  renderer.job = null;
  if (renderer.release !== undefined) window.clearTimeout(renderer.release);
  renderer.release = window.setTimeout(() => {
    if (stillRenderer === renderer && !renderer.job) dropStillRenderer();
  }, FX_STILL_RELEASE_MS);
}

/**
 * Draw `stored` as one still frame at the layout size of `layer` (the box it is for, which must be in the page),
 * copy it into a 2D canvas and resolve with that canvas; reject with an FxStillFailure. The drawing happens in the
 * shared still renderer, never in `layer`: nothing is added to the box.
 */
export function renderFxStill(
  layer: HTMLElement,
  stored: unknown,
  { resolveImage, pixelRatio, signal }: RenderFxStillOptions,
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const parsed = parseFxProp(stored);
    if (!parsed.ok) {
      reject("refused" satisfies FxStillFailure);
      return;
    }
    if (signal.aborted) {
      reject("aborted" satisfies FxStillFailure);
      return;
    }
    const width = layer.offsetWidth;
    const height = layer.offsetHeight;
    if (!layer.isConnected || width === 0 || height === 0) {
      reject("no-host" satisfies FxStillFailure);
      return;
    }
    // The size the picture must have: a frame drawn before the canvas took the new size is not this still.
    const wantWidth = Math.floor(width * pixelRatio);
    const wantHeight = Math.floor(height * pixelRatio);
    let finished = false;
    let firstAt = 0;
    let settle: number | undefined;
    let picture: HTMLCanvasElement | null = null;
    let renderer: ReturnType<typeof stillRendererFor> | null = null;

    const finish = (
      outcome:
        | { ok: true; canvas: HTMLCanvasElement }
        | { ok: false; reason: FxStillFailure },
    ) => {
      if (finished) return;
      finished = true;
      if (settle !== undefined) window.clearTimeout(settle);
      signal.removeEventListener("abort", onAbort);
      if (renderer && stillRenderer === renderer && renderer.job === job)
        releaseStillRendererLater();
      if (outcome.ok) resolve(outcome.canvas);
      else reject(outcome.reason);
    };
    const onAbort = () => finish({ ok: false, reason: "aborted" });
    signal.addEventListener("abort", onAbort);
    // A scene that never draws (an engine change, a stalled driver) must not hold the queue: one still runs at a time.
    settle = window.setTimeout(
      () => finish({ ok: false, reason: "empty" }),
      FX_STILL_FIRST_FRAME_MS,
    );

    const copy = () => {
      const source = renderer?.host.querySelector("canvas");
      if (
        !source ||
        Math.abs(source.width - wantWidth) > 1 ||
        Math.abs(source.height - wantHeight) > 1
      )
        return false;
      picture ??= document.createElement("canvas");
      picture.width = source.width;
      picture.height = source.height;
      const context = picture.getContext("2d");
      if (!context) return false;
      context.clearRect(0, 0, picture.width, picture.height);
      context.drawImage(source, 0, 0);
      return true;
    };
    const done = () => {
      if (picture) finish({ ok: true, canvas: picture });
      else finish({ ok: false, reason: "empty" });
    };
    const job: StillJob = {
      width,
      height,
      pixelRatio,
      onFrame: () => {
        if (finished || !copy()) return;
        const now = performance.now();
        if (firstAt === 0) firstAt = now;
        if (settle !== undefined) window.clearTimeout(settle);
        // Taken as it is once nothing more is drawn, or after the longest wait for a scene that keeps drawing.
        settle = window.setTimeout(
          done,
          now - firstAt >= FX_STILL_MAX_MS ? 0 : FX_STILL_SETTLE_MS,
        );
      },
      onFail: (reason) => finish({ ok: false, reason }),
    };
    renderer = stillRendererFor(
      job,
      withResolvedImages(parsed.fx.scene, resolveImage),
    );
  });
}

export interface MountFxOptions {
  /** The first frame is drawn and the layer is fading in. */
  onLive: () => void;
  /** The scene cannot be drawn, or stopped. The layer is already gone. */
  onOff: (reason: FxOffReason) => void;
}

/** Start drawing `stored` in `box`, in a layer made for it. Returns the teardown; safe to call more than once. */
export function mountFxScene(
  box: HTMLElement,
  stored: unknown,
  { onLive, onOff }: MountFxOptions,
): () => void {
  if (!parseFxProp(stored).ok) {
    onOff("refused");
    return () => {};
  }

  const release = holdFxBox(box);
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.setAttribute(FX_LAYER_ATTR, "");
  Object.assign(layer.style, FX_LAYER_STYLE);
  box.insertBefore(layer, box.firstChild);

  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    layer.remove();
    release();
  };

  const handle = renderFxScene(layer, stored, {
    onLive: () => {
      layer.style.opacity = "1";
      onLive();
    },
    onOff: (reason) => {
      remove();
      onOff(reason);
    },
  });

  return () => {
    handle.teardown();
    remove();
  };
}
