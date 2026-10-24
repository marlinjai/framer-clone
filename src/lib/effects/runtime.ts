// src/lib/effects/runtime.ts
//
// The client runtime for appear and parallax effects, shared by the preview
// (scrolling inside its frame) and the published page (scrolling the window).
// Vanilla DOM, no library: an IntersectionObserver reveals each appear element
// once, the Web Animations API plays the reveal from the start values the
// element's CSS custom properties carry (src/lib/effects/effects.ts), and a
// passive scroll listener batched through requestAnimationFrame moves parallax
// elements with the `translate` property only.
//
// Breakpoint-blind: every value is read from computed custom properties, which
// the published page's responsive stylesheet already switches per breakpoint.
//
// Under prefers-reduced-motion nothing moves: every appear element is marked
// shown at once and parallax never starts.

import { EASE_OUT, FX_ATTR, FX_VAR } from './effects';

export interface StartEffectsOptions {
  /** The subtree to look for effect elements in (the preview frame, or document). */
  container: ParentNode & Node;
  /**
   * The scrolling element, which is also the IntersectionObserver root: the
   * preview frame, or null for the window.
   */
  scrollRoot: HTMLElement | null;
  /**
   * False when the start-state CSS is not in force (it timed out on a slow
   * load, or was never injected): elements are then marked shown without a
   * reveal, since they are already visible.
   */
  animate?: boolean;
}

/** Reads (and keeps reading) the reduced-motion preference. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function numberVar(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const n = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(n) ? n : fallback;
}

function lengthVar(style: CSSStyleDeclaration, name: string): string {
  const raw = style.getPropertyValue(name).trim();
  return raw || '0px';
}

interface RevealTiming {
  opacity: number;
  x: string;
  y: string;
  scale: number;
  duration: number;
  delay: number;
  stagger: number;
}

function readTiming(el: Element): RevealTiming {
  const style = getComputedStyle(el);
  return {
    opacity: numberVar(style, FX_VAR.startOpacity, 1),
    x: lengthVar(style, FX_VAR.startX),
    y: lengthVar(style, FX_VAR.startY),
    scale: numberVar(style, FX_VAR.startScale, 1),
    duration: numberVar(style, FX_VAR.duration, 0),
    delay: numberVar(style, FX_VAR.delay, 0),
    stagger: numberVar(style, FX_VAR.stagger, 0),
  };
}

function isIdentity(t: RevealTiming): boolean {
  return t.opacity >= 1 && t.scale === 1 && parseFloat(t.x) === 0 && parseFloat(t.y) === 0;
}

/**
 * Play the reveal of `target` from its start values to its own resting state.
 * One keyframe: the browser animates to the element's current values, so its
 * own opacity, a parallax translate or a hover state are never overwritten
 * when the reveal ends. `fill: backwards` holds the start values during the
 * delay, in the same frame the start-state CSS stops applying, so there is no
 * flash. Returns the animation, or null when nothing plays.
 */
export function playReveal(target: Element, t: RevealTiming, delay: number): Animation | null {
  if (t.duration <= 0 || isIdentity(t) || typeof (target as HTMLElement).animate !== 'function') return null;
  return (target as HTMLElement).animate(
    [{ offset: 0, opacity: t.opacity, translate: `${t.x} ${t.y}`, scale: String(t.scale) }],
    { duration: t.duration, delay, easing: EASE_OUT, fill: 'backwards' },
  );
}

/** Mark an appear element (or each child of a staggered one) shown, playing the reveal when asked. */
export function reveal(el: Element, animate: boolean): void {
  if (el.hasAttribute(FX_ATTR.shown)) return;
  const timing = animate ? readTiming(el) : null;
  const targets = el.hasAttribute(FX_ATTR.stagger) ? Array.from(el.children) : [el];
  el.setAttribute(FX_ATTR.shown, '');
  targets.forEach((target, i) => {
    if (target !== el && target.hasAttribute(FX_ATTR.shown)) return;
    // A child with its own appear effect reveals on its own terms.
    if (target !== el && target.hasAttribute(FX_ATTR.appear)) return;
    // Read the child's start values (inherited from the container) before it
    // is marked shown, while the start-state rule still applies.
    const t = timing && target !== el ? { ...readTiming(target), duration: timing.duration } : timing;
    target.setAttribute(FX_ATTR.shown, '');
    if (t) playReveal(target, t, (timing?.delay ?? 0) + i * (timing?.stagger ?? 0));
  });
}

/**
 * Start the effects in `container`. Returns a cleanup that stops observing
 * and listening (elements already shown stay shown).
 */
export function startEffects({ container, scrollRoot, animate = true }: StartEffectsOptions): () => void {
  const reduced = prefersReducedMotion();
  const appearSelector = `[${FX_ATTR.appear}]`;
  const parallaxSelector = `[${FX_ATTR.parallax}]`;

  // ---- appear ----
  const canObserve = typeof IntersectionObserver === 'function';
  const observed = new WeakSet<Element>();
  const observer = canObserve && !reduced && animate
    ? new IntersectionObserver(
        entries => {
          for (const entry of entries) {
            const el = entry.target;
            const rootTop = entry.rootBounds?.top ?? 0;
            if (entry.isIntersecting) {
              observer?.unobserve(el);
              reveal(el, true);
            } else if (entry.boundingClientRect.bottom < rootTop) {
              // Already scrolled past (a restored scroll position or an
              // anchor jump): show it without playing a reveal nobody sees.
              observer?.unobserve(el);
              reveal(el, false);
            }
          }
        },
        // A reveal starts once the element's top passes the lower 10% of the
        // viewport, so it plays where it is seen; threshold 0 works for an
        // element taller than the viewport.
        { root: scrollRoot, rootMargin: '0px 0px -10% 0px', threshold: 0 },
      )
    : null;

  const trackAppear = (el: Element) => {
    if (observed.has(el) || el.hasAttribute(FX_ATTR.shown)) return;
    observed.add(el);
    if (observer) observer.observe(el);
    else reveal(el, false);
  };

  // ---- parallax ----
  const parallaxEls = new Set<HTMLElement>();
  const strengths = new WeakMap<HTMLElement, number>();
  const shifts = new WeakMap<HTMLElement, number>();
  let frame = 0;
  const viewport = () => {
    if (scrollRoot) {
      const r = scrollRoot.getBoundingClientRect();
      return { top: r.top, height: scrollRoot.clientHeight };
    }
    return { top: 0, height: window.innerHeight };
  };
  const readStrengths = () => {
    for (const el of parallaxEls) strengths.set(el, numberVar(getComputedStyle(el), FX_VAR.parallax, 0));
  };
  const updateParallax = () => {
    frame = 0;
    const vp = viewport();
    for (const el of parallaxEls) {
      const strength = strengths.get(el) ?? 0;
      if (strength <= 0) {
        if (shifts.has(el)) {
          el.style.translate = '';
          shifts.delete(el);
        }
        continue;
      }
      // Measure without our own shift so the position is the layout one.
      const shift = shifts.get(el) ?? 0;
      const rect = el.getBoundingClientRect();
      const center = rect.top - shift + rect.height / 2;
      const span = vp.height / 2 + rect.height / 2;
      if (span <= 0) continue;
      const progress = Math.max(-1, Math.min(1, (center - (vp.top + vp.height / 2)) / span));
      // The element lags the scroll: shifted toward the middle on the way in
      // and out, never more than `strength` px.
      const next = Math.round(-progress * strength * 10) / 10;
      shifts.set(el, next);
      el.style.translate = `0 ${next}px`;
    }
  };
  const requestParallax = () => {
    if (!frame && parallaxEls.size > 0) frame = requestAnimationFrame(updateParallax);
  };
  const onResize = () => {
    readStrengths();
    requestParallax();
  };
  const scrollTarget: HTMLElement | Window = scrollRoot ?? window;
  let listening = false;
  const trackParallax = (el: Element) => {
    if (reduced || !(el instanceof HTMLElement) || parallaxEls.has(el)) return;
    parallaxEls.add(el);
    strengths.set(el, numberVar(getComputedStyle(el), FX_VAR.parallax, 0));
    if (!listening) {
      listening = true;
      scrollTarget.addEventListener('scroll', requestParallax, { passive: true });
      window.addEventListener('resize', onResize, { passive: true });
    }
    requestParallax();
  };

  const scan = (root: ParentNode) => {
    if (root instanceof Element) {
      if (root.matches(appearSelector)) trackAppear(root);
      if (root.matches(parallaxSelector)) trackParallax(root);
    }
    root.querySelectorAll(appearSelector).forEach(trackAppear);
    root.querySelectorAll(parallaxSelector).forEach(trackParallax);
  };

  if (reduced || !animate) {
    container.querySelectorAll(appearSelector).forEach(el => reveal(el, false));
  }
  scan(container);

  // Elements added later (the preview re-renders while the page is edited, a
  // client island mounts content) are picked up too.
  const mutations = typeof MutationObserver === 'function'
    ? new MutationObserver(records => {
        for (const record of records) {
          record.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            if (reduced || !animate) {
              const el = node as Element;
              if (el.matches(appearSelector)) reveal(el, false);
              el.querySelectorAll(appearSelector).forEach(child => reveal(child, false));
            }
            scan(node as Element);
          });
          if (record.type === 'attributes' && record.target instanceof Element) scan(record.target);
        }
        readStrengths();
        requestParallax();
      })
    : null;
  mutations?.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [FX_ATTR.appear, FX_ATTR.parallax],
  });

  return () => {
    observer?.disconnect();
    mutations?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    if (listening) {
      scrollTarget.removeEventListener('scroll', requestParallax);
      window.removeEventListener('resize', onResize);
    }
    for (const el of parallaxEls) {
      if (shifts.has(el)) el.style.translate = '';
    }
  };
}
