// src/lib/behaviour/useSurfaceRuntime.ts
//
// Runs a page's behaviour program on one element of the editor: the preview's frame, or
// a canvas frame in the Interact tool. The chunks the program needs are fetched together,
// as BehaviourIsland does on the published page. A chunk that does not arrive leaves the
// frame at its first values, which is what it already shows, and says so. A new program,
// from an edit, stops the old run and starts again from the first values.
'use client';

import { useEffect, type RefObject } from 'react';
import type { BehaviourProgram } from './program';

/** Set on the element once the page runs there, or at once when there is nothing to run. */
export const SURFACE_RUNNING_ATTR = 'data-surface-running';

export function useSurfaceRuntime(
  frame: RefObject<HTMLElement | null>,
  program: BehaviourProgram | null,
  surface: 'preview' | 'canvas',
  /** False when nothing should run: the frame is drawn, but its page is not live. */
  live = true,
): void {
  useEffect(() => {
    const container = frame.current;
    if (!container || !live) return;
    let stop: (() => void) | undefined;
    let left = false;
    const running = () => container.setAttribute(SURFACE_RUNNING_ATTR, '');
    if (!program) {
      running();
      return () => container.removeAttribute(SURFACE_RUNNING_ATTR);
    }
    Promise.all([
      import('./runtime'),
      program.verbs ? import('./verbs') : undefined,
      program.rove ? import('./rove') : undefined,
    ]).then(
      ([{ startBehaviour }, verbs, rove]) => {
        if (left) return;
        stop = startBehaviour({ container, program, surface, verbs: verbs?.createVerbs, extras: verbs, rove: rove?.createRover });
        running();
      },
      (error: unknown) => console.error(`Page behaviour did not load in the ${surface === 'preview' ? 'preview' : 'canvas'}: it shows the first values.`, error),
    );
    return () => {
      left = true;
      stop?.();
      container.removeAttribute(SURFACE_RUNNING_ATTR);
    };
  }, [frame, program, surface, live]);
}
