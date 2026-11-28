// The particle ring's rules that hold without drawing (the picture itself is held by the pixel oracle,
// test/behaviour/fxRingOracle.spec.ts): the particles repeat for a seed, the radius follows the
// component's rule, the glow is the component's passes at whole numbers and weighted passes between, and the ring's one blend holds through the reader and
// through the reader (the editor's side: src/lib/fxScene/__tests__/particleRingEdit.test.ts).

import { describe, expect, it } from 'vitest';

import { PRESETS, deserializeScene, parseFxScene, serializeScene } from '@/lib/fx/format';
import {
  RING_POINTS_PER_STRAND,
  RING_STRANDS,
  buildRingParticles,
  mulberry32,
  RING_VERTEX,
  ringGlowPasses,
  ringGlowWeights,
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

  it('gives every whole pass full strength and the last the part of a number that is left', () => {
    expect(ringGlowWeights(0)).toEqual([]);
    expect(ringGlowWeights(0.01)).toEqual([0.01]);
    expect(ringGlowWeights(0.02)).toEqual([0.02]);
    expect(ringGlowWeights(1)).toEqual([1]);
    expect(ringGlowWeights(2)).toEqual([1, 1]);
    const between = ringGlowWeights(1.3);
    expect(between).toHaveLength(2);
    expect(between[0]).toBe(1);
    expect(between[1]).toBeCloseTo(0.3, 12);
    // Outside 0 to 2 it is held at the ends; a value that is no number is the brand ring.
    expect(ringGlowWeights(5)).toEqual([1, 1]);
    expect(ringGlowWeights(-1)).toEqual([]);
    expect(ringGlowWeights(Number.NaN)).toEqual([1]);
  });

  it('a whole number is exactly the component: every pass at strength 1', () => {
    for (const glow of [1, 2]) expect(ringGlowWeights(glow).every((w) => w === 1)).toBe(true);
  });

  it('more glow never means less light: the summed strength rises with the stored value, a hundredth at a time', () => {
    let last = -1;
    for (let i = 0; i <= 200; i++) {
      const sum = ringGlowWeights(i / 100).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(i / 100, 9);
      expect(sum).toBeGreaterThan(last);
      last = sum;
    }
  });

  it("the strength picks a share of the glow points and leaves the component's arithmetic as it is", () => {
    expect(RING_VERTEX).toContain('uniform float gain;');
    // The component's line, unchanged; a point outside the share is moved out of the picture.
    expect(RING_VERTEX).toContain('vA=glow>0.5 ? al*0.028 : al;');
    expect(RING_VERTEX).toContain('if(glow>0.5 && fract(rnd*997.0)>=gain)');
  });

  it('the scramble spreads a share evenly: about that share of the points, in every part of the ring', () => {
    const particles = buildRingParticles(1, mulberry32(1));
    const points = particles.length / 3;
    for (const share of [0.01, 0.25, 0.5, 0.9]) {
      const sectors = new Array(12).fill(0);
      const totals = new Array(12).fill(0);
      for (let i = 0; i < points; i++) {
        const th = particles[i * 3];
        const sector = Math.min(11, Math.floor(((th % (2 * Math.PI)) / (2 * Math.PI)) * 12));
        totals[sector]++;
        // The shader's test in single precision: fract(rnd * 997) < share.
        const scrambled = Math.fround(Math.fround(particles[i * 3 + 2]) * 997);
        if (scrambled - Math.floor(scrambled) < share) sectors[sector]++;
      }
      const drawn = sectors.reduce((a, b) => a + b, 0);
      expect(drawn / points).toBeCloseTo(share, 2);
      for (let k = 0; k < 12; k++) expect(Math.abs(sectors[k] / totals[k] - share)).toBeLessThan(0.02);
    }
  });
});

describe('a glow between whole numbers through the reader', () => {
  const sceneWithGlow = (glow: number) => {
    const scene = serializeScene(PRESETS.find((p) => p.id === 'lumitra-light')!.load()) as unknown as { layers: Array<{ params: Record<string, unknown> }> };
    scene.layers[0].params.glow = glow;
    return scene;
  };

  it.each([0.01, 0.02, 0.37, 1.5, 1.99])('keeps %s as it is stored', (glow) => {
    const read = parseFxScene(sceneWithGlow(glow));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const again = serializeScene(read.scene) as unknown as { layers: Array<{ params: Record<string, unknown> }> };
    expect(again.layers[0].params.glow).toBe(glow);
  });

  it('holds a value outside 0 to 2 at the ends', () => {
    for (const [stored, kept] of [[3, 2], [-0.5, 0]] as const) {
      const read = parseFxScene(sceneWithGlow(stored));
      expect(read.ok).toBe(true);
      if (read.ok) expect((serializeScene(read.scene) as unknown as { layers: Array<{ params: Record<string, unknown> }> }).layers[0].params.glow).toBe(kept);
    }
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
// ci-replay touch
