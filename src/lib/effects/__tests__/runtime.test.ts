import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FX_ATTR, FX_VAR, startStateCss } from '../effects';
import { startEffects as start } from '../runtime';

const stops: (() => void)[] = [];
const startEffects = (...args: Parameters<typeof start>) => {
  const stop = start(...args);
  stops.push(stop);
  return stop;
};

// jsdom has neither IntersectionObserver, matchMedia nor element.animate:
// stub all three and drive intersections by hand.
type IOCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let observers: { callback: IOCallback; targets: Set<Element>; options?: IntersectionObserverInit }[] = [];
let reducedMotion = false;
let animateCalls: { el: Element; keyframes: unknown; options: KeyframeAnimationOptions }[] = [];

class FakeIO {
  targets = new Set<Element>();
  constructor(public callback: IOCallback, public options?: IntersectionObserverInit) {
    observers.push(this);
  }
  observe(el: Element) { this.targets.add(el); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}

function intersect(el: Element, isIntersecting = true, bottom = 100) {
  for (const o of observers) {
    if (o.targets.has(el)) {
      o.callback([{ target: el, isIntersecting, boundingClientRect: { bottom } as DOMRect, rootBounds: { top: 0 } as DOMRect }]);
    }
  }
}

function appearEl(vars: Record<string, string> = {}, attrs: Record<string, string> = {}) {
  const el = document.createElement('div');
  el.setAttribute(FX_ATTR.appear, '');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const style = { [FX_VAR.startOpacity]: '0', [FX_VAR.startY]: '16px', [FX_VAR.duration]: '280', [FX_VAR.delay]: '0', [FX_VAR.stagger]: '0', ...vars };
  for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v);
  return el;
}

beforeEach(() => {
  observers = [];
  animateCalls = [];
  reducedMotion = false;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') ? reducedMotion : false, addEventListener() {}, removeEventListener() {} }));
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: unknown, options: KeyframeAnimationOptions) {
    animateCalls.push({ el: this, keyframes, options });
    return { cancel() {} } as unknown as Animation;
  };
  document.body.innerHTML = '';
});

afterEach(() => {
  while (stops.length) stops.pop()!();
  vi.unstubAllGlobals();
});

describe('appear', () => {
  it('reveals once when the element comes into view, from its start values', () => {
    const el = appearEl();
    document.body.appendChild(el);
    const stop = startEffects({ container: document, scrollRoot: null });
    expect(el.hasAttribute(FX_ATTR.shown)).toBe(false);
    intersect(el);
    expect(el.hasAttribute(FX_ATTR.shown)).toBe(true);
    expect(animateCalls).toHaveLength(1);
    const [frame] = animateCalls[0].keyframes as Record<string, unknown>[];
    expect(frame.opacity).toBe(0);
    expect(frame.translate).toBe('0px 16px');
    expect(animateCalls[0].options.duration).toBe(280);
    expect(animateCalls[0].options.easing).toBe('cubic-bezier(0.23, 1, 0.32, 1)');
    // Once: a second intersection plays nothing.
    intersect(el);
    expect(animateCalls).toHaveLength(1);
    stop();
  });

  it('shows an element already scrolled past without playing a reveal', () => {
    const el = appearEl();
    document.body.appendChild(el);
    startEffects({ container: document, scrollRoot: null });
    intersect(el, false, -50);
    expect(el.hasAttribute(FX_ATTR.shown)).toBe(true);
    expect(animateCalls).toHaveLength(0);
  });

  it('staggers the direct children, not the element', () => {
    const el = appearEl({ [FX_VAR.stagger]: '50', [FX_VAR.delay]: '100' }, { [FX_ATTR.stagger]: '' });
    for (let i = 0; i < 3; i++) el.appendChild(document.createElement('p'));
    document.body.appendChild(el);
    startEffects({ container: document, scrollRoot: null });
    intersect(el);
    expect(animateCalls.map(c => c.el)).toEqual(Array.from(el.children));
    expect(animateCalls.map(c => c.options.delay)).toEqual([100, 150, 200]);
    expect(Array.from(el.children).every(c => c.hasAttribute(FX_ATTR.shown))).toBe(true);
  });

  it('under reduced motion shows everything at once and observes nothing', () => {
    reducedMotion = true;
    const el = appearEl();
    document.body.appendChild(el);
    startEffects({ container: document, scrollRoot: null });
    expect(el.hasAttribute(FX_ATTR.shown)).toBe(true);
    expect(observers).toHaveLength(0);
    expect(animateCalls).toHaveLength(0);
  });

  it('without the start state in force (the boot script gave up) shows without animating', () => {
    const el = appearEl();
    document.body.appendChild(el);
    startEffects({ container: document, scrollRoot: null, animate: false });
    expect(el.hasAttribute(FX_ATTR.shown)).toBe(true);
    expect(animateCalls).toHaveLength(0);
  });

  it('uses the scroll root as the observer root (the preview frame)', () => {
    const frame = document.createElement('div');
    frame.appendChild(appearEl());
    document.body.appendChild(frame);
    startEffects({ container: frame, scrollRoot: frame });
    expect(observers[0].options?.root).toBe(frame);
  });

  it('picks up elements added later', async () => {
    startEffects({ container: document, scrollRoot: null });
    const el = appearEl();
    document.body.appendChild(el);
    await new Promise(r => setTimeout(r, 0));
    intersect(el);
    expect(el.hasAttribute(FX_ATTR.shown)).toBe(true);
  });
});

describe('no hidden content without JavaScript', () => {
  it('the start state is never in the server markup: it is a separate, scoped or injected sheet', () => {
    // The start-state selectors require either the scope attribute (preview)
    // or the injected sheet (published); the base markup of an appear element
    // carries only data attributes and custom properties, which hide nothing.
    const el = appearEl();
    expect(el.getAttribute('style')).not.toMatch(/opacity\s*:/);
    expect(startStateCss('[data-fx-on] ')).toContain('[data-fx-on] ');
  });
});

describe('parallax', () => {
  it('moves with translate only, within the strength, and not under reduced motion', async () => {
    const img = document.createElement('img');
    img.setAttribute(FX_ATTR.parallax, '');
    img.style.setProperty(FX_VAR.parallax, '20');
    img.getBoundingClientRect = () => ({ top: 2000, height: 200, bottom: 2200, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} });
    document.body.appendChild(img);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    const stop = startEffects({ container: document, scrollRoot: null });
    // Far below the viewport: clamped to the full strength.
    expect(img.style.translate).toBe('0 -20px');
    expect(img.style.transform).toBe('');
    stop();
    expect(img.style.translate).toBe('');

    reducedMotion = true;
    startEffects({ container: document, scrollRoot: null });
    expect(img.style.translate).toBe('');
  });
});
