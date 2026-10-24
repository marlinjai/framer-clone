// src/lib/effects/smoothScroll.ts
//
// Optional per-site smooth scrolling with Lenis (MIT, the `lenis` package,
// pinned). Off by default (the site setting `smoothScroll`), never under
// prefers-reduced-motion, never on the editor canvas (which pans its own
// camera and never calls this). Lenis is loaded on demand, so a site without
// the setting never downloads it. In-page anchor links keep working
// (`anchors: true` scrolls to the target through Lenis).

import { prefersReducedMotion } from './runtime';

/**
 * The few rules of lenis/dist/lenis.css a page needs while Lenis runs, inlined
 * so a site without smooth scrolling pays nothing for them.
 */
export const LENIS_CSS = [
  'html.lenis,html.lenis body{height:auto}',
  '.lenis:not(.lenis-autoToggle).lenis-stopped{overflow:clip}',
  '.lenis [data-lenis-prevent],.lenis [data-lenis-prevent-wheel],.lenis [data-lenis-prevent-touch]{overscroll-behavior:contain}',
  '.lenis.lenis-smooth iframe{pointer-events:none}',
].join('\n');

export interface SmoothScrollOptions {
  /** The scrolling element (the preview frame); omitted for the window. */
  wrapper?: HTMLElement;
  /** The element inside `wrapper` that holds the content. */
  content?: HTMLElement;
}

/**
 * Start Lenis unless the visitor asks for reduced motion. Returns a cleanup
 * that destroys it (safe to call before the import has resolved). A failed
 * import leaves native scrolling in place and logs once.
 */
export function startSmoothScroll(options: SmoothScrollOptions = {}): () => void {
  if (typeof window === 'undefined' || prefersReducedMotion()) return () => {};
  let destroyed = false;
  let instance: { destroy: () => void } | null = null;
  import('lenis')
    .then(({ default: Lenis }) => {
      if (destroyed) return;
      instance = new Lenis({
        ...(options.wrapper ? { wrapper: options.wrapper } : {}),
        ...(options.content ? { content: options.content } : {}),
        autoRaf: true,
        anchors: true,
      });
    })
    .catch(err => {
      console.warn('smoothScroll: Lenis could not be loaded, native scrolling stays on', err);
    });
  return () => {
    destroyed = true;
    instance?.destroy();
    instance = null;
  };
}
