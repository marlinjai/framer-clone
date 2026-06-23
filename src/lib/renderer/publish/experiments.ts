// src/lib/renderer/publish/experiments.ts
//
// Experiment -> publish-arm enumeration for the per-variant emit (publish spec
// P2b). framer-clone has NO experiment MST model today: experiment config lives
// in the server-side `site_experiments` table (persisted opaquely in P1b, shape
// owned by the P5 tooling). So the publisher receives experiment configs through
// `PublishOptions.experiments` rather than reading MST — the server publish
// caller loads them from `site_experiments` and passes them in.
//
// ARM MODEL (decision, see PR): we emit one artifact set per (experiment,
// variant) for each RUNNING experiment, plus the control baseline at the bundle
// root. We deliberately do NOT emit the full cartesian product across multiple
// experiments: independent single-experiment arms match the documented R2 key
// `_exp/<experimentKey>/<variant>/...` exactly, stay linearly bounded, and let
// the P3/P4 edge compose independent arms at request time. Total arms are CAPPED
// (`DEFAULT_MAX_VARIANT_ARMS`); an over-cap run is truncated deterministically
// and the overflow is reported (never silently dropped).

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'archived';

export interface ExperimentVariantConfig {
  /** URL-safe variant key, e.g. 'a' | 'b' | 'control'. */
  key: string;
  /** Optional traffic weight (informational here; the edge owns assignment). */
  weight?: number;
}

export interface ExperimentConfig {
  /** URL-safe experiment key, unique within a site (mirrors site_experiments). */
  experimentKey: string;
  status: ExperimentStatus;
  variants: ExperimentVariantConfig[];
}

/**
 * One publish arm: a single experiment forced to a single variant. `assignment`
 * is the `window.__AP_VARIANTS` object injected into that arm's HTML.
 */
export interface VariantArm {
  experimentKey: string;
  variant: string;
  /** The forced assignment for this arm, e.g. `{ 'hero-cta': 'b' }`. */
  assignment: Record<string, string>;
}

export interface EnumerateResult {
  /** The bounded set of arms to emit (excludes the control baseline). */
  arms: VariantArm[];
  /** Total arms requested before the cap was applied. */
  requested: number;
  /** True when `requested > cap` and `arms` was truncated. */
  capped: boolean;
  /** The cap that was applied. */
  cap: number;
}

// Default ceiling on emitted variant arms per publish. Generous for hand-authored
// experiments; the cap exists to stop a misconfigured experiment set from
// exploding the bundle. Override via `PublishOptions.maxVariantArms`.
export const DEFAULT_MAX_VARIANT_ARMS = 64;

/**
 * Enumerate the variant arms to emit from a set of experiment configs. Only
 * RUNNING experiments with at least one variant contribute. Output order is
 * deterministic: experiments in input order, variants in input order. Arms past
 * the cap are dropped from the tail and flagged via `capped`.
 */
export function enumerateVariantArms(
  experiments: ExperimentConfig[] | undefined,
  options: { cap?: number } = {},
): EnumerateResult {
  const cap = options.cap ?? DEFAULT_MAX_VARIANT_ARMS;
  const all: VariantArm[] = [];

  for (const exp of experiments ?? []) {
    if (exp.status !== 'running') continue;
    if (!exp.experimentKey) continue;
    for (const variant of exp.variants ?? []) {
      if (!variant.key) continue;
      all.push({
        experimentKey: exp.experimentKey,
        variant: variant.key,
        assignment: { [exp.experimentKey]: variant.key },
      });
    }
  }

  const requested = all.length;
  const capped = requested > cap;
  return {
    arms: capped ? all.slice(0, cap) : all,
    requested,
    capped,
    cap,
  };
}
