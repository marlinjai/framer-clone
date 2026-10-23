// src/lib/ai/pageGen/promptSections/effects.ts
//
// What the page generator may do with motion, and the model-facing text that
// says so. Kept in its own file so the effects rules stay together and
// prompt.ts (edited by several hands) only gains one line. Plan:
// docs/plans/2026-10-23-motion-effects.md.
//
// The generator may use APPEAR effects only, and sparingly: a hero reveal,
// section reveals, a staggered list. Hover and scroll effects are the
// designer's call in the properties panel: "hover on everything" and
// perpetual motion are tells of a generated page
// (docs/plans/2026-10-23-ai-design-quality-round-2.md), so the validator drops
// them. Values are clamped to the same limits as the panel
// (src/lib/effects/effects.ts).

import { APPEAR_KINDS, EFFECT_LIMITS, normalizeAppear, type AppearEffect } from '@/lib/effects/effects';

/** The node prop that carries effects (props.effects, as in the editor). */
export const EFFECTS_PROP = 'effects';

/** Most nodes one generation may give an appear effect; the rest are dropped with a warning. */
export const MAX_GENERATED_APPEARS = 8;

const kinds = APPEAR_KINDS.filter(k => k !== 'none').map(k => `"${k}"`).join(', ');

/** The "## Motion" section of the schema docs (part of the cached prefix: keep it tight). */
export function effectsDocs(): string {
  const { duration, stagger, delay } = EFFECT_LIMITS;
  return [
    '## Motion',
    '',
    `Optional "props.effects": {"appear": {"kind": <${kinds}>, "stagger": <ms>, "delay": <ms>}}.`,
    'An appear plays once when the element scrolls into view; the published page shows everything',
    'without it for visitors who ask for reduced motion. Use it sparingly, at most one per section:',
    '- the hero content block (fade or slide-up) and the headline block of a few sections;',
    `- a list, grid or row of cards or figures: "stagger" ${stagger.min} to ${stagger.max} on the parent, so its children`,
    '  reveal one after another (the parent needs at least two children);',
    `- "delay" (0 to ${delay.max}) only to follow a reveal right above. Duration is set by the editor`,
    `  (${duration.default}ms); never ask for slow or repeated motion.`,
    'Never on the navigation, the footer, body paragraphs or every element. No hover or scroll',
    `effects: those are dropped. At most ${MAX_GENERATED_APPEARS} appear effects per generation.`,
  ].join('\n');
}

/** The outcome of cleaning one node's generated effects. */
export interface CleanedEffects {
  /** The effects to store, or undefined for none. */
  effects?: { appear: AppearEffect };
  /** Human-readable reasons for anything dropped or changed. */
  warnings: string[];
}

/**
 * Validate one node's `props.effects` from the model. Keeps an appear only
 * (normalized and clamped), drops hover and scroll, ignores responsive maps
 * (the appear applies on every breakpoint; the designer can switch it off per
 * breakpoint), and turns stagger off on a node with fewer than two children.
 * `appearsSoFar` is the count already accepted in this generation.
 */
export function cleanGeneratedEffects(raw: unknown, childCount: number, appearsSoFar: number): CleanedEffects {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('props.effects must be an object, dropped');
    return { warnings };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === 'hover' || key === 'scroll') warnings.push(`effects.${key} is not generated (the designer sets it), dropped`);
    else if (key !== 'appear') warnings.push(`effects.${key} is not supported, dropped`);
  }
  let rawAppear = record.appear;
  if (rawAppear === undefined) return { warnings };
  if (rawAppear && typeof rawAppear === 'object' && !Array.isArray(rawAppear) && !('kind' in rawAppear) && 'base' in rawAppear) {
    warnings.push('effects.appear: per-breakpoint values are not generated, the base value is used');
    rawAppear = (rawAppear as Record<string, unknown>).base;
  }
  const kindRaw = typeof rawAppear === 'string' ? rawAppear : (rawAppear as Record<string, unknown> | null)?.kind;
  const appear = normalizeAppear(rawAppear);
  if (appear.kind === 'none') {
    if (kindRaw !== 'none' && kindRaw !== undefined) warnings.push(`effects.appear: unknown kind "${String(kindRaw)}", dropped`);
    return { warnings };
  }
  if (appearsSoFar >= MAX_GENERATED_APPEARS) {
    warnings.push(`more than ${MAX_GENERATED_APPEARS} appear effects, dropped (use them sparingly)`);
    return { warnings };
  }
  // The editor owns the duration and distance: always the defaults.
  const cleaned: AppearEffect = {
    ...appear,
    duration: EFFECT_LIMITS.duration.default,
    distance: EFFECT_LIMITS.distance.default,
  };
  if (cleaned.stagger > 0 && childCount < 2) {
    warnings.push('effects.appear.stagger needs at least two children, turned off');
    cleaned.stagger = 0;
  }
  return { effects: { appear: cleaned }, warnings };
}
