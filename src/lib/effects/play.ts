// src/lib/effects/play.ts
//
// The Effects section's Play control: plays an element's appear effect once on
// the editor canvas, where effects otherwise never run (the canvas always shows
// the final state). Nothing persists: a one-keyframe Web Animation from the
// start values to the element's resting state, with `fill: none`, so the
// element is exactly as before when it ends.

import { appearStart, type AppearEffect } from './effects';
import { playReveal } from './runtime';

/** The canvas elements of one component: in one breakpoint frame, or in every frame. */
export function canvasElementsOf(componentId: string, breakpointId?: string, root: ParentNode = document): HTMLElement[] {
  const escape = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"'));
  const selector = breakpointId
    ? `[data-component-id="${escape(`${breakpointId}-${componentId}`)}"]`
    : `[data-inner-component-id="${escape(componentId)}"]`;
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

/**
 * Play `appear` on the given elements (or each one's direct children, one
 * after another, for a staggered appear). Returns the started animations so a
 * caller can cancel them; empty for a none appear.
 */
export function playAppear(elements: readonly HTMLElement[], appear: AppearEffect): Animation[] {
  if (appear.kind === 'none') return [];
  const start = appearStart(appear);
  const timing = {
    opacity: start.opacity,
    x: `${start.x}px`,
    y: `${start.y}px`,
    scale: start.scale,
    duration: appear.duration,
    delay: appear.delay,
    stagger: appear.stagger,
  };
  const animations: Animation[] = [];
  for (const el of elements) {
    const targets = appear.stagger > 0 ? Array.from(el.children) : [el];
    targets.forEach((target, i) => {
      const animation = playReveal(target, timing, appear.delay + i * appear.stagger);
      if (animation) animations.push(animation);
    });
  }
  return animations;
}
