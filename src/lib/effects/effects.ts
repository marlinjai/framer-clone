// src/lib/effects/effects.ts
//
// Motion and effects on a component: what is stored, the limits every value is
// clamped to, how a stored value resolves per breakpoint, and how a resolved
// value becomes DOM attributes plus CSS custom properties for the preview and
// the published page. See docs/plans/2026-10-23-motion-effects.md.
//
// Stored on the component as `props.effects`:
//
//   {
//     appear: AppearEffect | { base: AppearEffect, <breakpointId>: AppearEffect },
//     hover:  HoverKind,                      (one value, not per breakpoint)
//     scroll: ScrollEffect | { base: ..., <breakpointId>: ... },
//   }
//
// `appear` and `scroll` cascade desktop-first like any responsive style
// (src/lib/responsive/cascade.ts), whole group at a time, so "none on Phone" is
// one override. `hover` is not responsive: it is gated by the pointer (a touch
// screen has no hover), not by the width.
//
// The motion rules are the owner's (the animate and emil-design-eng skills):
// entrances ease out with a strong curve, reveals stay short, nothing is
// perpetual, only transform and opacity move, everything is off under
// prefers-reduced-motion, and nothing is hidden unless JavaScript runs.
//
// PURE: no React, no MST, no DOM. Client and server safe.

import { isResponsiveMap, largestFirst, resolveCascade, type BreakpointRef } from '@/lib/responsive/cascade';

// ---------- the stored shape ----------

export const APPEAR_KINDS = ['none', 'fade', 'slide-up', 'slide-left', 'slide-right', 'scale'] as const;
export type AppearKind = (typeof APPEAR_KINDS)[number];

export const HOVER_KINDS = ['none', 'lift', 'dim', 'underline'] as const;
export type HoverKind = (typeof HOVER_KINDS)[number];

export const SCROLL_KINDS = ['none', 'parallax'] as const;
export type ScrollKind = (typeof SCROLL_KINDS)[number];

export interface AppearEffect {
  kind: AppearKind;
  /** Travel of a slide, in px. */
  distance: number;
  /** Length of the reveal, in ms. */
  duration: number;
  /** Wait before the reveal starts once the element is in view, in ms. */
  delay: number;
  /** When above 0 the direct children reveal one after another this many ms apart, not the element itself. */
  stagger: number;
}

export interface ScrollEffect {
  kind: ScrollKind;
  /** The largest shift of a parallax, in px, reached at the edges of the viewport. */
  strength: number;
}

export type EffectGroup = 'appear' | 'hover' | 'scroll';

/** `props.effects` as stored: appear and scroll may be responsive maps. */
export interface StoredEffects {
  appear?: unknown;
  hover?: unknown;
  scroll?: unknown;
}

/** One breakpoint's effects, every value normalized. */
export interface ResolvedEffects {
  appear: AppearEffect;
  hover: HoverKind;
  scroll: ScrollEffect;
}

// ---------- limits ----------

/**
 * Every bound in one place, read by the panel, the normalizer and the
 * generator's validator. Reveals are content on a marketing page, so they may
 * run a little longer than interface animations; the default stays under
 * 300ms and the ceiling is 400ms. Stagger is the 30 to 80ms band the skills
 * name. A parallax never shifts more than 40px.
 */
export const EFFECT_LIMITS = {
  distance: { min: 4, max: 48, default: 16 },
  duration: { min: 150, max: 400, default: 280 },
  delay: { min: 0, max: 600, default: 0 },
  stagger: { min: 30, max: 80, default: 50 },
  parallax: { min: 4, max: 40, default: 16 },
  /** A scale-in starts at this scale, never from 0. */
  scaleFrom: 0.96,
} as const;

/** The strong ease-out of the motion rules, for every entrance. */
export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

/** Hover feedback: near-imperceptible and fast, because hover happens tens of times a day. */
export const HOVER_DURATION_MS = 160;
export const HOVER_LIFT_PX = 2;
export const HOVER_DIM_OPACITY = 0.8;

export const NO_APPEAR: AppearEffect = {
  kind: 'none',
  distance: EFFECT_LIMITS.distance.default,
  duration: EFFECT_LIMITS.duration.default,
  delay: EFFECT_LIMITS.delay.default,
  stagger: 0,
};

export const NO_SCROLL: ScrollEffect = { kind: 'none', strength: EFFECT_LIMITS.parallax.default };

// ---------- normalizing ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clampNumber(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

function oneOf<T extends string>(list: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === 'string' && (list as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Stagger is off (0) or inside the 30 to 80ms band; anything in between snaps to the band. */
export function clampStagger(raw: unknown): number {
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return clampNumber(n, EFFECT_LIMITS.stagger.min, EFFECT_LIMITS.stagger.max, EFFECT_LIMITS.stagger.default);
}

/** Any input (stored, typed, generated) as a valid appear effect. Unknown kinds read as none. */
export function normalizeAppear(raw: unknown): AppearEffect {
  if (typeof raw === 'string') return normalizeAppear({ kind: raw });
  if (!isObject(raw)) return { ...NO_APPEAR };
  const { distance, duration, delay } = EFFECT_LIMITS;
  return {
    kind: oneOf(APPEAR_KINDS, raw.kind, 'none'),
    distance: clampNumber(raw.distance, distance.min, distance.max, distance.default),
    duration: clampNumber(raw.duration, duration.min, duration.max, duration.default),
    delay: clampNumber(raw.delay, delay.min, delay.max, delay.default),
    stagger: clampStagger(raw.stagger),
  };
}

export function normalizeHover(raw: unknown): HoverKind {
  return oneOf(HOVER_KINDS, raw, 'none');
}

export function normalizeScroll(raw: unknown): ScrollEffect {
  if (typeof raw === 'string') return normalizeScroll({ kind: raw });
  if (!isObject(raw)) return { ...NO_SCROLL };
  const { parallax } = EFFECT_LIMITS;
  return {
    kind: oneOf(SCROLL_KINDS, raw.kind, 'none'),
    strength: clampNumber(raw.strength, parallax.min, parallax.max, parallax.default),
  };
}

const NORMALIZERS = {
  appear: normalizeAppear,
  hover: normalizeHover,
  scroll: normalizeScroll,
} as const;

/** The stored effects record of a props object, or undefined when there is none. */
export function storedEffectsOf(props: unknown): StoredEffects | undefined {
  if (!isObject(props)) return undefined;
  const effects = props.effects;
  return isObject(effects) ? (effects as StoredEffects) : undefined;
}

/** True when a group is responsive (appear, scroll); hover is one value everywhere. */
export function isResponsiveGroup(group: EffectGroup): group is 'appear' | 'scroll' {
  return group !== 'hover';
}

/**
 * The normalized value of one group on `breakpointId`, cascaded desktop-first.
 * Hover ignores the breakpoint.
 */
export function resolveEffectGroup<G extends EffectGroup>(
  effects: StoredEffects | undefined,
  group: G,
  breakpointId: string | undefined,
  breakpoints: readonly BreakpointRef[],
): ResolvedEffects[G] {
  const stored = effects?.[group];
  const normalize = NORMALIZERS[group] as (raw: unknown) => ResolvedEffects[G];
  if (!isResponsiveGroup(group)) return normalize(stored);
  return normalize(resolveCascade(stored, breakpointId, breakpoints).value);
}

/** Every group on one breakpoint. */
export function resolveEffects(
  effects: StoredEffects | undefined,
  breakpointId: string | undefined,
  breakpoints: readonly BreakpointRef[],
): ResolvedEffects {
  return {
    appear: resolveEffectGroup(effects, 'appear', breakpointId, breakpoints),
    hover: resolveEffectGroup(effects, 'hover', breakpointId, breakpoints),
    scroll: resolveEffectGroup(effects, 'scroll', breakpointId, breakpoints),
  };
}

/** True when the resolved effects do anything at all. */
export function hasAnyEffect(resolved: ResolvedEffects): boolean {
  return resolved.appear.kind !== 'none' || resolved.hover !== 'none' || resolved.scroll.kind !== 'none';
}

/**
 * The stored record after writing one group, dropping groups that end up as
 * none so an element without effects stores nothing. Returns undefined when no
 * group is left.
 */
export function compactEffects(effects: StoredEffects): StoredEffects | undefined {
  const out: StoredEffects = {};
  if (normalizeHover(effects.hover) !== 'none') out.hover = effects.hover;
  for (const group of ['appear', 'scroll'] as const) {
    const value = effects[group];
    if (isObject(value) && !('kind' in value)) {
      // A responsive map: it may hold a none override on a smaller
      // breakpoint, which must stay. Only an empty map carries nothing.
      if (Object.keys(value).length > 0) out[group] = value;
      continue;
    }
    // A plain value: none carries no information.
    if (NORMALIZERS[group](value).kind !== 'none') out[group] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------- the DOM contract (preview and published page) ----------

/** Attributes the runtime and the effects stylesheet key on. */
export const FX_ATTR = {
  /** An element with an appear effect (on at least one breakpoint). */
  appear: 'data-fx-a',
  /** An appear element whose direct children reveal one after another. */
  stagger: 'data-fx-st',
  /** An element with a parallax (on at least one breakpoint). */
  parallax: 'data-fx-p',
  /** The hover kind: lift, dim or underline. */
  hover: 'data-fx-h',
  /** Set by the runtime once an element has revealed; the start state no longer applies. */
  shown: 'data-fx-in',
  /** Set on the preview frame when motion is allowed: turns the start-state rules on there. */
  scope: 'data-fx-on',
} as const;

/** CSS custom properties carrying one element's effect values (per breakpoint on the published page). */
export const FX_VAR = {
  startOpacity: '--fx-o0',
  startX: '--fx-x0',
  startY: '--fx-y0',
  startScale: '--fx-s0',
  duration: '--fx-d',
  delay: '--fx-dl',
  stagger: '--fx-st',
  parallax: '--fx-ps',
} as const;

/** The start state of an appear effect: where the element comes from. */
export function appearStart(appear: AppearEffect): { opacity: number; x: number; y: number; scale: number } {
  const d = appear.distance;
  switch (appear.kind) {
    case 'fade': return { opacity: 0, x: 0, y: 0, scale: 1 };
    case 'slide-up': return { opacity: 0, x: 0, y: d, scale: 1 };
    case 'slide-left': return { opacity: 0, x: -d, y: 0, scale: 1 };
    case 'slide-right': return { opacity: 0, x: d, y: 0, scale: 1 };
    case 'scale': return { opacity: 0, x: 0, y: 0, scale: EFFECT_LIMITS.scaleFrom };
    default: return { opacity: 1, x: 0, y: 0, scale: 1 };
  }
}

/**
 * The custom properties for one breakpoint's appear and scroll values. A none
 * appear is the identity start state (opacity 1, no offset), so the start-state
 * rule hides nothing on that breakpoint; a none scroll is a strength of 0.
 */
export function effectVars(resolved: Pick<ResolvedEffects, 'appear' | 'scroll'>): Record<string, string> {
  const start = appearStart(resolved.appear);
  return {
    [FX_VAR.startOpacity]: String(start.opacity),
    [FX_VAR.startX]: `${start.x}px`,
    [FX_VAR.startY]: `${start.y}px`,
    [FX_VAR.startScale]: String(start.scale),
    [FX_VAR.duration]: String(resolved.appear.kind === 'none' ? 0 : resolved.appear.duration),
    [FX_VAR.delay]: String(resolved.appear.delay),
    [FX_VAR.stagger]: String(resolved.appear.stagger),
    [FX_VAR.parallax]: String(resolved.scroll.kind === 'parallax' ? resolved.scroll.strength : 0),
  };
}

/** What a node renders for its effects: attributes plus style entries (custom properties). */
export interface EffectDomOutput {
  attributes: Record<string, string>;
  /** Custom properties, plain values or responsive maps keyed by breakpoint id (published page). */
  style: Record<string, unknown>;
  /** The node needs the client runtime (an appear or a parallax somewhere). */
  needsRuntime: boolean;
}

/**
 * The DOM output for one breakpoint, for a surface that renders one width at a
 * time (the preview). Undefined when the node has no effect on it.
 */
export function effectDomForBreakpoint(resolved: ResolvedEffects): EffectDomOutput | undefined {
  if (!hasAnyEffect(resolved)) return undefined;
  const attributes: Record<string, string> = {};
  if (resolved.appear.kind !== 'none') {
    attributes[FX_ATTR.appear] = '';
    if (resolved.appear.stagger > 0) attributes[FX_ATTR.stagger] = '';
  }
  if (resolved.scroll.kind === 'parallax') attributes[FX_ATTR.parallax] = '';
  if (resolved.hover !== 'none') attributes[FX_ATTR.hover] = resolved.hover;
  const needsRuntime = resolved.appear.kind !== 'none' || resolved.scroll.kind === 'parallax';
  return { attributes, style: needsRuntime ? effectVars(resolved) : {}, needsRuntime };
}

/**
 * The DOM output across every breakpoint, for the published page, which
 * cannot pick a width at render time: each custom property becomes a
 * responsive map (`{ base, <breakpointId>: value }`) that the responsive
 * stylesheet turns into media queries, exactly like a responsive style. The
 * whole group is resolved per breakpoint (one variable depends on several
 * fields, e.g. the kind and the distance), at the largest breakpoint and at
 * every breakpoint that sets its own appear or scroll.
 */
export function effectDomAcrossBreakpoints(
  effects: StoredEffects | undefined,
  breakpoints: readonly BreakpointRef[],
): EffectDomOutput | undefined {
  if (!effects) return undefined;
  const ordered = largestFirst(breakpoints);
  const ids = new Set(ordered.map(b => b.id));
  const primaryId = ordered[0]?.id;
  const overrideIds = new Set<string>();
  for (const group of ['appear', 'scroll'] as const) {
    const stored = effects[group];
    if (!isResponsiveMap(stored, ids)) continue;
    for (const key of Object.keys(stored)) if (key !== 'base' && key !== primaryId && ids.has(key)) overrideIds.add(key);
  }
  const at = (id: string | undefined) => resolveEffects(effects, id, ordered);
  const base = at(primaryId);
  const perBreakpoint = ordered.filter(b => overrideIds.has(b.id)).map(b => ({ id: b.id, resolved: at(b.id) }));
  const all = [base, ...perBreakpoint.map(p => p.resolved)];

  const anyAppear = all.some(r => r.appear.kind !== 'none');
  const anyStagger = all.some(r => r.appear.kind !== 'none' && r.appear.stagger > 0);
  const anyParallax = all.some(r => r.scroll.kind === 'parallax');
  const hover = base.hover;
  if (!anyAppear && !anyParallax && hover === 'none') return undefined;

  const attributes: Record<string, string> = {};
  if (anyAppear) attributes[FX_ATTR.appear] = '';
  if (anyStagger) attributes[FX_ATTR.stagger] = '';
  if (anyParallax) attributes[FX_ATTR.parallax] = '';
  if (hover !== 'none') attributes[FX_ATTR.hover] = hover;

  const needsRuntime = anyAppear || anyParallax;
  const style: Record<string, unknown> = {};
  if (needsRuntime) {
    const baseVars = effectVars(base);
    const varsPer = perBreakpoint.map(p => ({ id: p.id, vars: effectVars(p.resolved) }));
    for (const [name, value] of Object.entries(baseVars)) {
      const overrides = varsPer.filter(p => p.vars[name] !== value);
      if (overrides.length === 0) {
        style[name] = value;
        continue;
      }
      const map: Record<string, string> = { base: value };
      for (const p of overrides) map[p.id] = p.vars[name];
      style[name] = map;
    }
  }
  return { attributes, style, needsRuntime };
}

// ---------- the stylesheets ----------

/**
 * The always-on effects CSS: hover feedback only. Hover moves only on a real
 * pointer, and its motion is off under reduced motion (dim and underline stay,
 * they are state changes, not movement). Never `transition: all`.
 */
export const EFFECTS_BASE_CSS = [
  '@media (hover:hover) and (pointer:fine){',
  `[${FX_ATTR.hover}=dim]:hover{opacity:${HOVER_DIM_OPACITY}}`,
  `[${FX_ATTR.hover}=underline]:hover{text-decoration-line:underline;text-underline-offset:0.2em}`,
  '}',
  '@media (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){',
  `[${FX_ATTR.hover}=lift],[${FX_ATTR.hover}=dim]{transition:translate ${HOVER_DURATION_MS}ms ease,opacity ${HOVER_DURATION_MS}ms ease}`,
  `[${FX_ATTR.hover}=lift]:hover{translate:0 -${HOVER_LIFT_PX}px}`,
  '}',
].join('\n');

/**
 * The start-state CSS: an appear element (or each child of a staggered one)
 * waits at its start values until the runtime marks it shown. This text is
 * never part of the server HTML: the published page injects it from an inline
 * script (so without JavaScript nothing is hidden), and the preview scopes it
 * to its frame's `data-fx-on`, set only when motion is allowed. It also sits
 * behind prefers-reduced-motion. Opacity is `!important` so an element's own
 * inline opacity cannot show it early; it applies only until it is shown.
 */
export function startStateCss(scope = ''): string {
  const a = FX_ATTR;
  const v = FX_VAR;
  const declarations =
    `opacity:var(${v.startOpacity},1)!important;` +
    `translate:var(${v.startX},0px) var(${v.startY},0px);` +
    `scale:var(${v.startScale},1)`;
  return [
    '@media (prefers-reduced-motion:no-preference){',
    `${scope}[${a.appear}]:not([${a.stagger}]):not([${a.shown}]),` +
      `${scope}[${a.appear}][${a.stagger}]>*:not([${a.shown}]){${declarations}}`,
    '}',
  ].join('\n');
}

// ---------- the published page's boot script ----------

/** Id of the injected start-state <style> on the published page. */
export const START_STYLE_ID = 'fc-fx-start';

/** The global the runtime island sets once it runs, read by the boot script's fallback. */
export const READY_GLOBAL = '__fcFxReady';

/**
 * How long the start state may hold before the boot script gives up on the
 * runtime (a failed or very slow script load) and shows everything.
 */
export const START_STATE_TIMEOUT_MS = 3000;

/**
 * The inline script the published page runs while its HTML is parsed, ahead
 * of the content. Unless the visitor asks for reduced motion it injects the
 * start-state rules into <head>, so appear elements wait for their reveal
 * without a visible-hidden-visible flash, and it removes them again if the
 * runtime has not started within START_STATE_TIMEOUT_MS. Without JavaScript
 * it never runs and nothing is hidden. Only constants go into it; `<` is
 * escaped so the text can never close the script element.
 */
export function publishedEffectsBootScript(): string {
  const css = JSON.stringify(startStateCss()).replace(/</g, '\\u003c');
  return (
    '(function(){try{' +
    "if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;" +
    `var s=document.createElement('style');s.id=${JSON.stringify(START_STYLE_ID)};s.textContent=${css};` +
    'document.head.appendChild(s);' +
    `setTimeout(function(){if(!window.${READY_GLOBAL}&&s.parentNode)s.parentNode.removeChild(s)},${START_STATE_TIMEOUT_MS});` +
    '}catch(e){}})();'
  );
}
