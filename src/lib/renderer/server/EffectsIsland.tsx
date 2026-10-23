// EffectsIsland: the published page's client boundary for motion. Renders
// nothing; once hydrated it starts the appear and parallax runtime on the
// window (src/lib/effects/runtime.ts) and, when the site turned it on, Lenis
// smooth scrolling (src/lib/effects/smoothScroll.ts). Both stay off under
// prefers-reduced-motion.
'use client';

import { useEffect } from 'react';
import { READY_GLOBAL, START_STYLE_ID } from '@/lib/effects/effects';
import { startEffects } from '@/lib/effects/runtime';
import { startSmoothScroll } from '@/lib/effects/smoothScroll';

export interface EffectsIslandProps {
  /** Some node has an appear or a parallax. */
  effects: boolean;
  /** The site's smooth scrolling setting. */
  smoothScroll: boolean;
}

export default function EffectsIsland({ effects, smoothScroll }: EffectsIslandProps) {
  useEffect(() => {
    if (!effects) return;
    (window as unknown as Record<string, unknown>)[READY_GLOBAL] = true;
    // The boot script's start-state rules are gone when it gave up waiting
    // (or never ran): elements are then already visible, so they are marked
    // shown without a reveal.
    const animate = document.getElementById(START_STYLE_ID) !== null;
    return startEffects({ container: document, scrollRoot: null, animate });
  }, [effects]);

  useEffect(() => {
    if (!smoothScroll) return;
    return startSmoothScroll();
  }, [smoothScroll]);

  return null;
}
