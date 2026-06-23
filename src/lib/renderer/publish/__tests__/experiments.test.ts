import { describe, it, expect } from 'vitest';
import {
  enumerateVariantArms,
  DEFAULT_MAX_VARIANT_ARMS,
  type ExperimentConfig,
} from '@/lib/renderer/publish/experiments';

describe('enumerateVariantArms', () => {
  it('returns no arms when there are no experiments', () => {
    const r = enumerateVariantArms(undefined);
    expect(r.arms).toEqual([]);
    expect(r.requested).toBe(0);
    expect(r.capped).toBe(false);
  });

  it('emits one arm per variant for RUNNING experiments only', () => {
    const experiments: ExperimentConfig[] = [
      {
        experimentKey: 'hero-cta',
        status: 'running',
        variants: [{ key: 'a' }, { key: 'b' }],
      },
      {
        experimentKey: 'draft-exp',
        status: 'draft',
        variants: [{ key: 'a' }, { key: 'b' }],
      },
    ];
    const r = enumerateVariantArms(experiments);
    expect(r.arms).toEqual([
      { experimentKey: 'hero-cta', variant: 'a', assignment: { 'hero-cta': 'a' } },
      { experimentKey: 'hero-cta', variant: 'b', assignment: { 'hero-cta': 'b' } },
    ]);
    expect(r.requested).toBe(2);
    expect(r.capped).toBe(false);
  });

  it('keeps independent arms across multiple running experiments (not cartesian)', () => {
    const experiments: ExperimentConfig[] = [
      { experimentKey: 'x', status: 'running', variants: [{ key: 'a' }, { key: 'b' }] },
      { experimentKey: 'y', status: 'running', variants: [{ key: 'a' }] },
    ];
    const r = enumerateVariantArms(experiments);
    expect(r.arms.map((a) => `${a.experimentKey}/${a.variant}`)).toEqual([
      'x/a',
      'x/b',
      'y/a',
    ]);
  });

  it('caps the arm count and flags it (never silently truncates)', () => {
    const experiments: ExperimentConfig[] = [
      {
        experimentKey: 'big',
        status: 'running',
        variants: Array.from({ length: 5 }, (_, i) => ({ key: `v${i}` })),
      },
    ];
    const r = enumerateVariantArms(experiments, { cap: 3 });
    expect(r.arms).toHaveLength(3);
    expect(r.requested).toBe(5);
    expect(r.capped).toBe(true);
    expect(r.cap).toBe(3);
  });

  it('skips experiments/variants with empty keys', () => {
    const experiments: ExperimentConfig[] = [
      { experimentKey: '', status: 'running', variants: [{ key: 'a' }] },
      { experimentKey: 'ok', status: 'running', variants: [{ key: '' }, { key: 'b' }] },
    ];
    const r = enumerateVariantArms(experiments);
    expect(r.arms).toEqual([
      { experimentKey: 'ok', variant: 'b', assignment: { ok: 'b' } },
    ]);
  });

  it('exposes a sane default cap', () => {
    expect(DEFAULT_MAX_VARIANT_ARMS).toBeGreaterThan(0);
  });
});
