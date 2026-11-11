// FxIsland: the published page's client boundary for FX scenes (src/lib/fxScene).
// Renders nothing. Rendered only on a page whose FX program is not empty.
//
// It is deliberately small and imports no engine code: every client component of
// a route lands in its page chunk, on pages that use it or not. The engine
// (three.js) and the scene reader are one separate chunk, src/lib/fxScene/mount,
// fetched by the dynamic import below, and only when a scene will really be
// drawn. In order, for each page:
//
//   1. One WebGL context per page. The first FX box in the document gets it;
//      every other box stays `calm` (its own CSS background and its children).
//   2. Reduced motion: with `calm: background` nothing is fetched or drawn. With
//      `calm: frame` the scene is drawn, and the engine holds it as one still
//      frame.
//   3. A WebGL probe (a throwaway context, released at once). No WebGL: nothing
//      is fetched.
//   4. The start: `settled` (the window's `load` event, or now when it already
//      fired, plus 1.5 seconds), `visible` (the box within one viewport height),
//      or `immediate`.
//   5. The chunk is fetched and the scene mounted; it fades in on its first frame.
//
// Whatever fails (no WebGL, a chunk that does not arrive, a refused scene, a
// renderer error, a lost context) leaves the box as the server sent it, with one
// console warning. The scene is decoration, so there is no visible error.
//
// What the island is doing is written on the box as `data-fc-fx-state`
// (src/lib/fxScene/marker.ts), for tests and for diagnosis.
//
// Leaving the page (`pagehide`) tears the scene down and releases its context; a
// page restored from the back/forward cache (`pageshow`) starts again.
'use client';

import { useEffect } from 'react';
import { FX_INDEX_ATTR, FX_STATE_ATTR, type FxState } from '@/lib/fxScene/marker';

/** The shape of one program entry the island itself reads (the rest is the mount's). */
export interface FxProgramEntry {
  start: 'settled' | 'visible' | 'immediate';
  calm: 'background' | 'frame';
}

/** After the page's `load` event: what lumitra.co waits before its hero starts. */
export const FX_SETTLE_DELAY_MS = 1500;

const WARNING = 'An FX scene could not be drawn here; the page shows its background instead.';

function setState(box: Element, state: FxState): void {
  box.setAttribute(FX_STATE_ATTR, state);
}

/** One throwaway context, released at once, so the probe holds no slot of the browser's limit. */
function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Calls `go` when the scene may start; returns a cancel. */
function whenStarted(box: Element, start: FxProgramEntry['start'], go: () => void): () => void {
  if (start === 'immediate') {
    go();
    return () => {};
  }
  if (start === 'visible') {
    if (typeof IntersectionObserver === 'undefined') {
      go();
      return () => {};
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        go();
      },
      // One viewport height above and below: the scene is ready as the box scrolls in.
      { rootMargin: '100% 0px' },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }
  let timer: number | undefined;
  const arm = () => {
    timer = window.setTimeout(go, FX_SETTLE_DELAY_MS);
  };
  // `load` may have fired before this effect ran (a late hydration).
  if (document.readyState === 'complete') arm();
  else window.addEventListener('load', arm, { once: true });
  return () => {
    window.removeEventListener('load', arm);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

/** Runs the page's FX program once; returns the teardown. */
function run(program: readonly FxProgramEntry[]): () => void {
  const boxes = [...document.querySelectorAll<HTMLElement>(`[${FX_INDEX_ATTR}]`)];
  let owner: HTMLElement | undefined;
  let entry: FxProgramEntry | undefined;
  for (const box of boxes) {
    const candidate = program[Number(box.getAttribute(FX_INDEX_ATTR))];
    if (!owner && candidate) {
      owner = box;
      entry = candidate;
    } else {
      // A second scene on the page, or a mark with no entry behind it.
      setState(box, candidate ? 'calm' : 'off');
    }
  }
  if (!owner || !entry) return () => {};
  const box = owner;
  const scene = entry;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && scene.calm === 'background') {
    setState(box, 'calm');
    return () => {};
  }
  if (!hasWebGL()) {
    setState(box, 'off');
    console.warn(WARNING, 'WebGL is not available.');
    return () => {};
  }

  let left = false;
  let unmount: (() => void) | undefined;
  setState(box, 'waiting');
  const cancelStart = whenStarted(box, scene.start, () => {
    if (left) return;
    setState(box, 'loading');
    import('@/lib/fxScene/mount').then(
      ({ mountFxScene }) => {
        if (left) return;
        unmount = mountFxScene(box, scene, {
          onLive: () => setState(box, 'live'),
          onOff: (reason) => {
            unmount = undefined;
            setState(box, 'off');
            console.warn(WARNING, `Reason: ${reason}.`);
          },
        });
      },
      (error: unknown) => {
        if (left) return;
        setState(box, 'off');
        console.warn(WARNING, 'The engine did not load.', error);
      },
    );
  });

  return () => {
    left = true;
    cancelStart();
    unmount?.();
    unmount = undefined;
    box.removeAttribute(FX_STATE_ATTR);
  };
}

export default function FxIsland({ program }: { program: readonly FxProgramEntry[] }) {
  useEffect(() => {
    let stop: (() => void) | undefined = run(program);
    // A page put into the back/forward cache keeps its DOM but must give up its
    // WebGL context; when it is shown again the scene starts over.
    const onHide = () => {
      stop?.();
      stop = undefined;
    };
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted && !stop) stop = run(program);
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      stop?.();
    };
  }, [program]);

  return null;
}
