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
//      fired, then the browser's first idle moment, at most half a second),
//      `visible` (the box within one viewport height), or `immediate`. A
//      `settled` or `immediate` scene fetches the engine chunk at once, while it
//      waits; a `visible` one only once it starts, so a scene nobody scrolls to
//      costs nothing.
//   5. The scene is mounted; it fades in on its first frame. A scene that is one
//      particle ring shows its own first frame meanwhile, drawn at once without the
//      engine (src/lib/fxScene/ringStill.ts), which stays under the live layer until
//      its fade is over. Any other scene shows a quiet placeholder while the wait is
//      noticeable (src/lib/fxScene/placeholder.ts), which cross-fades with the scene.
//
// Whatever fails (no WebGL, a chunk that does not arrive, a refused scene, a
// renderer error, a lost context) leaves the box as the server sent it, with one
// console warning; the scene is decoration, so there is no visible error. The one
// exception is a particle ring's still (src/lib/fxScene/ringStill.ts): when the
// engine cannot draw, the still stays as the picture, because it is the scene's own
// first frame (a refused scene takes it away).
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
import { showFxPlaceholder, type FxPlaceholder } from '@/lib/fxScene/placeholder';
import type { StoredFx } from '@/lib/fx/format';
import { ringStillSpecOf, showFxRingStill, type FxRingStill } from '@/lib/fxScene/ringStill';
import { FX_REDUCED_MOTION_QUERY, FX_SETTLE_IDLE_MS, FX_WARNING, fxStartDecision, whenStarted, type FxStartSettings } from '@/lib/fxScene/start';

/** The shape of one program entry the island itself reads (the rest is the mount's): its start, and its scene for a ring's still. */
export type FxProgramEntry = FxStartSettings & Pick<StoredFx, 'scene'>;

export { FX_SETTLE_IDLE_MS };

/**
 * The engine chunk, fetched once per page and shared by every run of the program (a preference change, a
 * page restored from the back/forward cache). A failed fetch is forgotten, so the next run may try again.
 */
let engine: Promise<typeof import('@/lib/fxScene/mount')> | null = null;
function loadEngine(): Promise<typeof import('@/lib/fxScene/mount')> {
  engine ??= import('@/lib/fxScene/mount').catch((error: unknown) => {
    engine = null;
    throw error;
  });
  return engine;
}

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
  const reduce = window.matchMedia(FX_REDUCED_MOTION_QUERY).matches;
  // A particle ring shows its own first frame while the engine comes (src/lib/fxScene/ringStill.ts); any
  // other scene, or a ring this browser cannot draw that way, shows the loading placeholder.
  const ringStill = ringStillSpecOf(scene);
  let still: FxRingStill | null = null;
  let stillTried = false;
  let placeholder: FxPlaceholder | undefined;
  const showPlaceholder = () => {
    if (still) return;
    if (ringStill && !stillTried) {
      stillTried = true;
      still = showFxRingStill(box, ringStill);
      if (still) return;
    }
    placeholder ??= showFxPlaceholder(box, { reduce });
  };
  const dropPlaceholder = (now = false) => {
    placeholder?.remove({ now });
    placeholder = undefined;
  };
  /** Gone at once, or (`under`, the live layer fading in) once that layer is fully opaque over it. */
  const dropStill = (under?: HTMLElement) => {
    still?.remove({ under });
    if (!under) still = null;
  };
  setState(box, 'waiting');
  // A scene that is certain to start fetches its engine while it waits, and shows its still (or the
  // placeholder, if the wait gets noticeable). Its failure is handled where it is awaited, below.
  if (scene.start !== 'visible') {
    loadEngine().catch(() => {});
    showPlaceholder();
  }
  const cancelStart = whenStarted(box, scene.start, () => {
    if (left) return;
    setState(box, 'loading');
    showPlaceholder();
    // One handler for a chunk that does not arrive and for a set-up that throws: either
    // way the box is off and says so, never left "loading".
    loadEngine()
      .then(({ mountFxScene }) => {
        if (left) return;
        unmount = mountFxScene(box, scene, {
          onLive: (layer) => {
            dropPlaceholder();
            // Under the live layer until that layer is fully opaque, then gone: no dip in brightness.
            dropStill(layer);
            setState(box, 'live');
          },
          onOff: (reason) => {
            unmount = undefined;
            dropPlaceholder();
            // The still is the scene's own first frame: it stays when the engine cannot draw (the scene is
            // decoration, and this is the picture a visitor asking for reduced motion gets anyway), but not
            // for a scene the engine refused.
            if (reason === 'refused') dropStill();
            setState(box, 'off');
            console.warn(WARNING, `Reason: ${reason}.`);
          },
        });
      })
      .catch((error: unknown) => {
        if (left) return;
        dropPlaceholder();
        // The still stays, as for an engine that cannot draw (above).
        setState(box, 'off');
        console.warn(WARNING, 'The engine did not load.', error);
      });
  });

  return () => {
    left = true;
    dropPlaceholder(true);
    dropStill();
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
