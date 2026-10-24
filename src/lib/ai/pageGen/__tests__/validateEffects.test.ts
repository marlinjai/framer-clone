// The generator's motion: appear effects only, clamped to the editor's
// limits, capped per generation, never hover or scroll; documented in the
// schema docs' Motion section.
import { describe, expect, it } from 'vitest';
import ComponentModel from '@/models/ComponentModel';
import { validateGeneration } from '../validate';
import { deriveBreakpointKeys } from '../schema';
import { buildSchemaDocs } from '../schemaDocs';
import { MAX_GENERATED_APPEARS } from '../promptSections/effects';
import { EFFECT_LIMITS } from '@/lib/effects/effects';

const breakpoints = deriveBreakpointKeys([
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Mobile', minWidth: 320 },
]);

function run(nodes: unknown[]) {
  let n = 0;
  const out = validateGeneration({ nodes }, { breakpoints, newId: () => `id${(n += 1)}` });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

const p = (t: string) => ({ type: 'p', props: { children: t } });

describe('generated effects', () => {
  it('keeps an appear, with the editor defaults for duration and distance', () => {
    const { nodes, warnings } = run([
      { type: 'section', props: { effects: { appear: { kind: 'slide-up', duration: 5000, distance: 300 } } }, children: [p('a')] },
    ]);
    expect(nodes[0].props.effects).toEqual({
      appear: { kind: 'slide-up', duration: EFFECT_LIMITS.duration.default, distance: EFFECT_LIMITS.distance.default, delay: 0, stagger: 0 },
    });
    expect(warnings).toEqual([]);
    // The snapshot is MST-valid with the effect on it.
    expect(() => ComponentModel.create(nodes[0])).not.toThrow();
  });

  it('drops hover and scroll, and unknown kinds', () => {
    const { nodes, warnings } = run([
      { type: 'div', props: { effects: { hover: 'lift', scroll: { kind: 'parallax' } } }, children: [p('a')] },
      { type: 'div', props: { effects: { appear: { kind: 'bounce' } } }, children: [p('b')] },
    ]);
    expect(nodes[0].props.effects).toBeUndefined();
    expect(nodes[1].props.effects).toBeUndefined();
    expect(warnings.some(w => w.includes('effects.hover'))).toBe(true);
    expect(warnings.some(w => w.includes('effects.scroll'))).toBe(true);
    expect(warnings.some(w => w.includes('unknown kind "bounce"'))).toBe(true);
  });

  it('clamps stagger into 30 to 80ms and turns it off without two children', () => {
    const { nodes, warnings } = run([
      { type: 'div', props: { effects: { appear: { kind: 'fade', stagger: 500 } } }, children: [p('a'), p('b'), p('c')] },
      { type: 'div', props: { effects: { appear: { kind: 'fade', stagger: 60 } } }, children: [p('only')] },
    ]);
    const staggerOf = (i: number) => (nodes[i].props.effects as { appear: { stagger: number } }).appear.stagger;
    expect(staggerOf(0)).toBe(80);
    expect(staggerOf(1)).toBe(0);
    expect(warnings.some(w => w.includes('at least two children'))).toBe(true);
  });

  it(`caps appear effects at ${MAX_GENERATED_APPEARS} per generation, keeping the outer ones`, () => {
    const sections = Array.from({ length: MAX_GENERATED_APPEARS + 2 }, (_, i) => ({
      type: 'section',
      props: { effects: { appear: 'fade' } },
      children: [{ type: 'h2', props: { children: `S${i}`, effects: { appear: 'slide-up' } } }],
    }));
    const { nodes, warnings } = run(sections);
    const count = (list: typeof nodes): number =>
      list.reduce((sum, n) => sum + (n.props.effects ? 1 : 0) + count(n.children), 0);
    expect(count(nodes)).toBe(MAX_GENERATED_APPEARS);
    expect(nodes[0].props.effects).toBeDefined();
    expect(warnings.some(w => w.includes('sparingly'))).toBe(true);
  });

  it('documents the Motion rules in the schema docs', () => {
    const docs = buildSchemaDocs();
    expect(docs).toContain('## Motion');
    expect(docs).toContain('"stagger"');
    expect(docs).toContain('No hover or scroll');
    expect(docs).not.toMatch(/[\u2013\u2014]/);
  });
});
