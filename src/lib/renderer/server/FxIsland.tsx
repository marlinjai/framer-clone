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
// A change of the reduced-motion preference runs the steps again for the page.
// Leaving the page (`pagehide`) tears the scene down and releases its context; a
// page restored from the back/forward cache (`pageshow`) starts again.
'use client';

import { useEffect } from 'react';
import { FX_INDEX_ATTR, FX_STATE_ATTR, type FxState } from '@/lib/fxScene/marker';
import { FX_REDUCED_MOTION_QUERY, FX_SETTLE_DELAY_MS, FX_WARNING, fxStartDecision, whenStarted, type FxStartSettings } from '@/lib/fxScene/start';

/** The shape of one program entry the island itself reads (the rest is the mount's). */
export type FxProgramEntry = FxStartSettings;

export { FX_SETTLE_DELAY_MS };

const WARNING = FX_WARNING;

function setState(box: Element, state: FxState): void {
  box.setAttribute(FX_STATE_ATTR, state);
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

  // Steps 2 and 3, shared with the editor's preview (src/lib/fxScene/start.ts).
  const decision = fxStartDecision(scene);
  if (decision === 'calm') {
    setState(box, 'calm');
    return () => {};
  }
  if (decision === 'off') {
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
    // The preference can change while the page is open: run the program again, so
    // a waiting or live scene follows its `calm` setting (a background scene is
    // dropped, a frame scene is remounted with the new preference).
    const reduced = window.matchMedia(FX_REDUCED_MOTION_QUERY);
    const onPreference = () => {
      if (!stop) return;
      stop();
      stop = run(program);
    };
    reduced.addEventListener('change', onPreference);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      reduced.removeEventListener('change', onPreference);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      stop?.();
    };
  }, [program]);

  return null;
}
