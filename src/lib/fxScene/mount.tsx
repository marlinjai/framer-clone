// src/lib/fxScene/mount.tsx
//
// Draws one FX scene into its box on a page. This file and everything it imports
// (the engine with three.js, the strict reader with the layer schemas) is ONE
// lazy chunk: FxIsland reaches it by a dynamic import, only on a page that has a
// scene to draw, only once WebGL is known to work. Nothing else may import it
// (asserted in src/lib/fx/__tests__/boundaryGuard.test.ts).
//
// The scene is read through the strict reader a second time here, on the client,
// so what is drawn never depends on the server having checked it.
//
// The canvas sits in a layer of its own, the box's first child: absolutely
// placed over the whole box, BEHIND the box's content, taking no pointer and
// hidden from assistive technology. It starts transparent and fades in over 300
// milliseconds once the first frame is drawn. When the scene cannot draw (or
// stops), the layer is taken out again and the box is exactly what the server
// sent.
'use client';

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { LumitraScene, type SceneFailure } from '@/lib/fx';
import { parseFxProp } from './fxScene';
import { FX_LAYER_ATTR } from './marker';

/** The fade once the first frame is drawn: the ceiling for interface motion. */
export const FX_FADE_MS = 300;

export interface MountFxOptions {
  /** The first frame is drawn and the layer is fading in. */
  onLive: () => void;
  /** The scene cannot be drawn, or stopped. The layer is already gone. */
  onOff: (reason: SceneFailure | 'refused') => void;
}

/** Start drawing `stored` in `box`. Returns the teardown; safe to call more than once. */
export function mountFxScene(box: HTMLElement, stored: unknown, { onLive, onOff }: MountFxOptions): () => void {
  const parsed = parseFxProp(stored);
  if (!parsed.ok) {
    onOff('refused');
    return () => {};
  }

  // The layer goes behind the box's content. A negative z-index does that only
  // inside a stacking context of the box's own, or it would slip behind the
  // box's background and the page; `isolation` makes one without moving
  // anything. A box left `position: static` would not contain the layer at all.
  const restore = { isolation: box.style.isolation, position: box.style.position };
  box.style.isolation = 'isolate';
  if (getComputedStyle(box).position === 'static') box.style.position = 'relative';

  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute(FX_LAYER_ATTR, '');
  Object.assign(layer.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '-1',
    overflow: 'hidden',
    pointerEvents: 'none',
    opacity: '0',
    transition: `opacity ${FX_FADE_MS}ms ease-out`,
    borderRadius: 'inherit',
  });
  box.insertBefore(layer, box.firstChild);

  let root: Root | null = createRoot(layer);
  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    // Unmounting disposes the renderer and releases the WebGL context.
    root?.unmount();
    root = null;
    layer.remove();
    box.style.isolation = restore.isolation;
    box.style.position = restore.position;
  };

  root.render(
    createElement(LumitraScene, {
      config: parsed.fx.scene,
      onFirstFrame: () => {
        if (done) return;
        layer.style.opacity = '1';
        onLive();
      },
      onFail: (reason: SceneFailure) => {
        if (done) return;
        // Not inside React's own commit: unmounting a root from its effect is refused.
        queueMicrotask(() => {
          teardown();
          onOff(reason);
        });
      },
    }),
  );

  return teardown;
}
