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
//  - `mountFxScene` is the published page's: it makes the layer itself, as the
//    box's first child (./box.ts says how it sits there), fades it in on the first
//    frame, and takes it out again when the scene cannot draw (or stops), so the
//    box is exactly what the server sent.
'use client';

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { LumitraScene, type SceneFailure } from '@/lib/fx';
import type { SceneConfig } from '@/lib/fx/format';
import { FX_FADE_MS, FX_LAYER_STYLE, holdFxBox } from './box';
import { parseFxProp } from './fxScene';
import { FX_LAYER_ATTR } from './marker';

export { FX_FADE_MS };

/** Why nothing is drawn: the engine's own reasons, or a scene the strict reader refused. */
export type FxOffReason = SceneFailure | 'refused';

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
}

export interface FxSceneHandle {
  /** Draw this scene instead, in the same context. A refused scene clears the layer and reports `refused`. */
  update: (stored: unknown) => void;
  /** Stop drawing and release the WebGL context. Safe to call more than once. */
  teardown: () => void;
}

/** The scene with every image address as this surface fetches it. */
function withResolvedImages(scene: SceneConfig, resolveImage: RenderFxOptions['resolveImage']): SceneConfig {
  if (!resolveImage) return scene;
  let changed = false;
  const layers = scene.layers.map((layer) => {
    const src = layer.type === 'image' ? layer.params.src : undefined;
    if (!src || src.type !== 'string' || src.value === '') return layer;
    const resolved = resolveImage(src.value) ?? '';
    if (resolved === src.value) return layer;
    changed = true;
    return { ...layer, params: { ...layer.params, src: { ...src, value: resolved } } };
  });
  return changed ? { ...scene, layers } : scene;
}

/** Draw `stored` into `layer`, which the caller owns and has placed. */
export function renderFxScene(layer: HTMLElement, stored: unknown, { onLive, onOff, resolveImage, layoutSize }: RenderFxOptions): FxSceneHandle {
  let root: Root | null = null;
  let done = false;
  // One per root: a scene that failed is not drawn again by a later update of the same root.
  let failed = false;
  // Whether the current root has drawn its first frame.
  let firstFrame = false;

  const unmount = () => {
    // Unmounting disposes the renderer and releases the WebGL context.
    root?.unmount();
    root = null;
  };

  const draw = (value: unknown) => {
    if (done || failed) return;
    const parsed = parseFxProp(value);
    if (!parsed.ok) {
      unmount();
      onOff('refused');
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

export interface MountFxOptions {
  /** The first frame is drawn and the layer is fading in. */
  onLive: () => void;
  /** The scene cannot be drawn, or stopped. The layer is already gone. */
  onOff: (reason: FxOffReason) => void;
}

/** Start drawing `stored` in `box`, in a layer made for it. Returns the teardown; safe to call more than once. */
export function mountFxScene(box: HTMLElement, stored: unknown, { onLive, onOff }: MountFxOptions): () => void {
  if (!parseFxProp(stored).ok) {
    onOff('refused');
    return () => {};
  }

  const release = holdFxBox(box);
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute(FX_LAYER_ATTR, '');
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
      layer.style.opacity = '1';
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
