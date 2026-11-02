// EffectsIsland: the published page's client boundary for motion. Renders
// nothing; once hydrated it starts the appear and parallax runtime on the
// window (src/lib/effects/runtime.ts) and, when the site turned it on, Lenis
// smooth scrolling (src/lib/effects/smoothScroll.ts). Both stay off under
// prefers-reduced-motion.
//
// Both are separate chunks, reached by a dynamic import, because all client
// components of a route land in its page chunk, on pages that use them or not.
// The boot script keeps its start-state rules until it hears the runtime is here,
// and drops them on its own timeout when it never is, so a chunk that does not
// arrive leaves elements visible.
'use client';

import { useEffect } from 'react';
import { READY_GLOBAL, START_STYLE_ID } from '@/lib/effects/effects';

export interface EffectsIslandProps {
  /** Some node has an appear or a parallax. */
  effects: boolean;
  /** The site's smooth scrolling setting. */
  smoothScroll: boolean;
}

/** Runs what a chunk starts, until the effect's cleanup, reporting a chunk that failed. */
function startLater(load: () => Promise<() => void>): () => void {
  let stop: (() => void) | undefined;
  let left = false;
  load().then(
    (started) => {
      if (left) started();
      else stop = started;
    },
    (error: unknown) => console.error('Page motion did not load.', error),
  );
  return () => {
    left = true;
    stop?.();
  };
}

export default function EffectsIsland({ effects, smoothScroll }: EffectsIslandProps) {
  useEffect(() => {
    if (!effects) return;
    return startLater(async () => {
      const { startEffects } = await import('@/lib/effects/runtime');
      (window as unknown as Record<string, unknown>)[READY_GLOBAL] = true;
      // The boot script's start-state rules are gone when it gave up waiting
      // (or never ran): elements are then already visible, so they are marked
      // shown without a reveal.
      const animate = document.getElementById(START_STYLE_ID) !== null;
      return startEffects({ container: document, scrollRoot: null, animate });
    });
  }, [effects]);

  useEffect(() => {
    if (!smoothScroll) return;
    return startLater(async () => (await import('@/lib/effects/smoothScroll')).startSmoothScroll());
  }, [smoothScroll]);

  return null;
}
