import { describe, expect, it } from 'vitest';
import {
  EFFECT_LIMITS,
  EFFECTS_BASE_CSS,
  FX_ATTR,
  FX_VAR,
  appearStart,
  compactEffects,
  effectDomAcrossBreakpoints,
  effectDomForBreakpoint,
  normalizeAppear,
  normalizeScroll,
  publishedEffectsBootScript,
  resolveEffects,
  startStateCss,
} from '../effects';

const BPS = [
  { id: 'desktop', minWidth: 1200 },
  { id: 'tablet', minWidth: 810 },
  { id: 'phone', minWidth: 0 },
];

const slideUp = { kind: 'slide-up', distance: 20, duration: 280, delay: 0, stagger: 0 };
const none = { kind: 'none', distance: 16, duration: 280, delay: 0, stagger: 0 };

describe('normalizing', () => {
  it('clamps every value into the motion rules', () => {
    const a = normalizeAppear({ kind: 'slide-up', distance: 500, duration: 2000, delay: -5, stagger: 10 });
    expect(a).toEqual({ kind: 'slide-up', distance: 48, duration: 400, delay: 0, stagger: 30 });
    expect(normalizeAppear({ kind: 'bounce' }).kind).toBe('none');
    expect(normalizeAppear('fade').kind).toBe('fade');
    expect(normalizeAppear(undefined).duration).toBeLessThan(300);
    expect(normalizeAppear({ kind: 'fade', stagger: 0 }).stagger).toBe(0);
    expect(normalizeAppear({ kind: 'fade', stagger: 999 }).stagger).toBe(EFFECT_LIMITS.stagger.max);
    expect(normalizeScroll({ kind: 'parallax', strength: 300 }).strength).toBe(EFFECT_LIMITS.parallax.max);
  });

  it('never starts a scale-in from 0', () => {
    expect(appearStart(normalizeAppear({ kind: 'scale' })).scale).toBe(EFFECT_LIMITS.scaleFrom);
  });
});

describe('cascade', () => {
  it('resolves appear desktop-first and keeps hover the same everywhere', () => {
    const effects = { appear: { base: slideUp, phone: none }, hover: 'dim' };
    expect(resolveEffects(effects, 'desktop', BPS).appear.kind).toBe('slide-up');
    expect(resolveEffects(effects, 'tablet', BPS).appear.kind).toBe('slide-up');
    expect(resolveEffects(effects, 'phone', BPS).appear.kind).toBe('none');
    expect(resolveEffects(effects, 'phone', BPS).hover).toBe('dim');
  });

  it('drops groups that are none, but keeps a map holding a none override', () => {
    expect(compactEffects({ appear: none, hover: 'none' })).toBeUndefined();
    expect(compactEffects({ appear: { base: slideUp, phone: none } })).toEqual({ appear: { base: slideUp, phone: none } });
    expect(compactEffects({ appear: slideUp, scroll: { kind: 'none' } })).toEqual({ appear: slideUp });
  });
});

describe('DOM output', () => {
  it('for one breakpoint: attributes and custom properties, nothing for none', () => {
    const dom = effectDomForBreakpoint(resolveEffects({ appear: slideUp, hover: 'lift' }, 'desktop', BPS))!;
    expect(dom.attributes).toEqual({ [FX_ATTR.appear]: '', [FX_ATTR.hover]: 'lift' });
    expect(dom.style[FX_VAR.startY]).toBe('20px');
    expect(dom.style[FX_VAR.startOpacity]).toBe('0');
    expect(dom.needsRuntime).toBe(true);
    expect(effectDomForBreakpoint(resolveEffects({ appear: { base: slideUp, phone: none } }, 'phone', BPS))).toBeUndefined();
  });

  it('a hover-only element needs no runtime', () => {
    const dom = effectDomForBreakpoint(resolveEffects({ hover: 'dim' }, 'desktop', BPS))!;
    expect(dom.needsRuntime).toBe(false);
    expect(dom.style).toEqual({});
  });

  it('across breakpoints: a value that differs becomes a responsive map (none on phone is the identity start)', () => {
    const dom = effectDomAcrossBreakpoints({ appear: { base: slideUp, phone: none } }, BPS)!;
    expect(dom.attributes[FX_ATTR.appear]).toBe('');
    expect(dom.style[FX_VAR.startOpacity]).toEqual({ base: '0', phone: '1' });
    expect(dom.style[FX_VAR.startY]).toEqual({ base: '20px', phone: '0px' });
    // The same on every breakpoint: a plain value.
    expect(dom.style[FX_VAR.startX]).toBe('0px');
  });

  it('marks stagger and parallax', () => {
    const dom = effectDomAcrossBreakpoints(
      { appear: { ...slideUp, stagger: 60 }, scroll: { kind: 'parallax', strength: 20 } },
      BPS,
    )!;
    expect(dom.attributes[FX_ATTR.stagger]).toBe('');
    expect(dom.attributes[FX_ATTR.parallax]).toBe('');
    expect(dom.style[FX_VAR.stagger]).toBe('60');
    expect(dom.style[FX_VAR.parallax]).toBe('20');
  });

  it('returns nothing for an element with only none effects', () => {
    expect(effectDomAcrossBreakpoints({ appear: none }, BPS)).toBeUndefined();
  });
});

describe('stylesheets and boot script', () => {
  it('moves only transform and opacity, never transition: all, and gates motion', () => {
    const css = EFFECTS_BASE_CSS + startStateCss();
    expect(css).not.toMatch(/transition:\s*all/);
    expect(css).not.toMatch(/ease-in[^-]/);
    expect(css).toContain('prefers-reduced-motion:no-preference');
    expect(EFFECTS_BASE_CSS).toContain('(hover:hover) and (pointer:fine)');
    // Lift moves only with motion allowed.
    const motionBlock = EFFECTS_BASE_CSS.split('prefers-reduced-motion:no-preference')[1];
    expect(motionBlock).toContain('=lift]:hover');
  });

  it('scopes the start state and releases it once shown', () => {
    const css = startStateCss('[data-fx-on] ');
    expect(css).toContain(`[data-fx-on] [${FX_ATTR.appear}]:not([${FX_ATTR.stagger}]):not([${FX_ATTR.shown}])`);
    expect(css).toContain(`[${FX_ATTR.stagger}]>*:not([${FX_ATTR.shown}])`);
  });

  it('the boot script checks reduced motion, falls back on a timeout, and cannot close its element', () => {
    const script = publishedEffectsBootScript();
    expect(script).toContain('prefers-reduced-motion: reduce');
    expect(script).toContain('setTimeout');
    expect(script).not.toContain('<');
  });
});
