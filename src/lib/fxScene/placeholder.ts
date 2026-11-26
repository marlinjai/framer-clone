// src/lib/fxScene/placeholder.ts
//
// What an FX scene box shows while its scene is genuinely still loading (the engine
// being fetched, the first frame being built), so a visitor is not left looking at a
// blank area with no hint that something is on its way: a soft glow in the middle of
// the box, in the box's own text colour at a low strength (so it reads on a dark and
// on a light box alike), that breathes slowly.
//
//  - It appears only once the wait is noticeable (FX_PLACEHOLDER_DELAY_MS): a scene
//    that is there sooner never shows it, so a fast load does not flicker.
//  - It cross-fades with the scene's own fade-in, so there is no gap and no jump.
//  - Under reduced motion it does not breathe: one quiet glow, faded in.
//  - Decoration only: hidden from assistive technology, takes no pointer, behind the
//    box's content exactly as the scene's layer is (./box.ts).
//
// Used by the published page's island and the editor's still frames. No engine code;
// the motion is the Web Animations API, so no style sheet is added to the page.

import { FX_FADE_MS, holdFxBox } from './box';
import { FX_LAYER_ATTR, FX_PLACEHOLDER_ATTR } from './marker';

/** How long a scene may take before the placeholder shows: below this, a load reads as instant. */
export const FX_PLACEHOLDER_DELAY_MS = 400;
/** One slow breath, in and out. */
export const FX_PLACEHOLDER_BREATH_MS = 2400;

/** The placeholder's own style, as CSS property names. */
export const FX_PLACEHOLDER_STYLE = {
  position: 'absolute',
  inset: '0',
  zIndex: '-1',
  pointerEvents: 'none',
  borderRadius: 'inherit',
  opacity: '0',
  transition: `opacity ${FX_FADE_MS}ms ease-out`,
  background: 'radial-gradient(ellipse 55% 50% at 50% 50%, color-mix(in srgb, currentColor 10%, transparent), transparent 75%)',
} as const;

/** Start the slow breath on a shown placeholder (not under reduced motion). Returns the stop. */
export function breathe(element: HTMLElement, reduce: boolean): () => void {
  if (reduce || typeof element.animate !== 'function') return () => {};
  const animation = element.animate([{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }], {
    duration: FX_PLACEHOLDER_BREATH_MS,
    iterations: Infinity,
    easing: 'ease-in-out',
    delay: FX_FADE_MS,
  });
  return () => animation.cancel();
}

export interface FxPlaceholder {
  /**
   * The scene is there (fading in), or will not come: fade out over the same time, then give the box back.
   * `now`: gone at once, box given back at once (the page is put away, the program runs again).
   */
  remove: (options?: { now?: boolean }) => void;
}

/**
 * Show the placeholder in `box` once the wait passes FX_PLACEHOLDER_DELAY_MS. The box is held (./box.ts)
 * while it is there. Removing it before the delay shows nothing at all.
 */
export function showFxPlaceholder(box: HTMLElement, { reduce }: { reduce: boolean }): FxPlaceholder {
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute(FX_PLACEHOLDER_ATTR, '');
  Object.assign(element.style, FX_PLACEHOLDER_STYLE);
  let release: ((positionIsOwned?: boolean) => void) | null = null;
  let stopBreath = () => {};
  let removed = false;

  const timer = window.setTimeout(() => {
    if (removed) return;
    release = holdFxBox(box);
    // The scene's layer is always the box's first child (./mount.tsx): a placeholder that comes after it sits behind it in the tree.
    const first = box.firstElementChild;
    box.insertBefore(element, first?.hasAttribute(FX_LAYER_ATTR) ? first.nextSibling : box.firstChild);
    // Laid out once at opacity 0, so the change to 1 is a transition and not a jump.
    void element.offsetWidth;
    element.style.opacity = '1';
    stopBreath = breathe(element, reduce);
  }, FX_PLACEHOLDER_DELAY_MS);

  return {
    remove: ({ now = false } = {}) => {
      if (removed) return;
      removed = true;
      window.clearTimeout(timer);
      if (!release) return;
      stopBreath();
      const done = release;
      const finish = () => {
        element.remove();
        done();
      };
      if (now) {
        finish();
        return;
      }
      element.style.opacity = '0';
      window.setTimeout(finish, FX_FADE_MS);
    },
  };
}
