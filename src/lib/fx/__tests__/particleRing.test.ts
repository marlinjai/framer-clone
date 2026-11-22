// The particle ring's rules that hold without drawing (the picture itself is held by the pixel oracle,
// test/behaviour/fxRingOracle.spec.ts): the particles repeat for a seed, the radius follows the
// component's rule, the glow is whole passes, and the ring's one blend holds through the reader and
// through the reader (the editor's side: src/lib/fxScene/__tests__/particleRingEdit.test.ts).

import { describe, expect, it } from 'vitest';

import { PRESETS, deserializeScene, parseFxScene, serializeScene } from '@/lib/fx/format';
import {
  RING_POINTS_PER_STRAND,
  RING_STRANDS,
  buildRingParticles,
  mulberry32,
  ringGlowPasses,
  ringPointsPerStrand,
  ringRadius,
} from '../particleRingCore';

describe('the particles', () => {
  it('are the same for a seed and different for another', () => {
    const a = buildRingParticles(1, mulberry32(1));
    const b = buildRingParticles(1, mulberry32(1));
    const c = buildRingParticles(1, mulberry32(2));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("are drawn in the component's order: per strand one phase, then per point one random", () => {
    // The component: for k { ph = random() * 0.01; for n { th = n / N * 2pi + ph; u = k / (K - 1); rnd = random() } }.
    const draws: number[] = [];
    const counting = () => {
      const value = (draws.length % 97) / 97;
      draws.push(value);
      return value;
    };
    const data = buildRingParticles(0.25, counting);
    const n = ringPointsPerStrand(0.25);
    expect(draws).toHaveLength(RING_STRANDS * (n + 1));
    // Strand 1, point 0: its phase is the strand's first draw, its random the draw after it.
    const strand = 1;
    const first = strand * (n + 1);
    const offset = strand * n * 3;
    expect(data[offset]).toBeCloseTo(draws[first] * 0.01, 6);
    expect(data[offset + 1]).toBeCloseTo(strand / (RING_STRANDS - 1), 6);
    expect(data[offset + 2]).toBeCloseTo(draws[first + 1], 6);
  });

  it('scale with the density as the component rounds it, kept inside 0.25 to 1', () => {
    expect(ringPointsPerStrand(1)).toBe(RING_POINTS_PER_STRAND);
    expect(ringPointsPerStrand(0.5)).toBe(380);
    expect(ringPointsPerStrand(0.1)).toBe(190);
    expect(ringPointsPerStrand(3)).toBe(RING_POINTS_PER_STRAND);
    expect(ringPointsPerStrand(Number.NaN)).toBe(RING_POINTS_PER_STRAND);
    expect(buildRingParticles(0.5, mulberry32(1))).toHaveLength(RING_STRANDS * 380 * 3);
  });

  it('come from a generator that stays in [0, 1)', () => {
    const random = mulberry32(42);
    for (let i = 0; i < 10_000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('the radius and the glow', () => {
  it('takes the smaller of 0.37 of the width and 0.47 of the height', () => {
    expect(ringRadius(960, 540)).toBeCloseTo(253.8, 6); // the height decides
    expect(ringRadius(390, 700)).toBeCloseTo(144.3, 6); // the width decides
  });

  it("draws the glow passes the component's loop draws: one per started whole number, 0 to 2", () => {
    expect([0, 0.4, 0.6, 1, 1.2, 1.6, 2, 5, -1].map(ringGlowPasses)).toEqual([0, 1, 1, 1, 2, 2, 2, 2, 0]);
    expect(ringGlowPasses(Number.NaN)).toBe(1);
  });
});

describe('the one blend of the ring', () => {
  const ringScene = () => serializeScene(PRESETS.find((p) => p.id === 'lumitra-light')!.load()) as unknown as Record<string, unknown> & { layers: Array<Record<string, unknown>> };

  it('is "add" in the preset', () => {
    expect(ringScene().layers[0]).toMatchObject({ type: 'particleRing', blend: 'add' });
  });

  it('is stored as "add" whatever a scene says, with a note', () => {
    const scene = ringScene();
    scene.layers[0] = { ...scene.layers[0], blend: 'multiply' };
    const parsed = parseFxScene(scene);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.scene.layers[0].blend).toBe('add');
    expect(parsed.notes.join(' ')).toMatch(/always blends as "add"/);
  });

  it('is "add" through the preset loader too, whatever a scene says', () => {
    const scene = ringScene();
    scene.layers[0] = { ...scene.layers[0], blend: 'screen' };
    expect(deserializeScene(scene).layers[0].blend).toBe('add');
  });
});
