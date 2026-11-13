// @vitest-environment node
// Effects that apply to one content layer (`Layer.target`): the reader's rules,
// the planner's groups, and the proof that a scene without a target plans
// exactly as it did before targets existed.

import { describe, expect, it } from 'vitest';

import { FX_LIMITS, deserializeScene, parseFxScene, serializeScene, type SceneConfig } from '../format';
import { planPipeline } from '../pipeline';
import { getLayerSchema } from '../registry';
import type { Layer } from '../types';

import v7 from './fixtures/v7.json';
import bokeh from '../presets/preset-bokeh-focuspull.json';
import godrays from '../presets/preset-godrays-hero.json';
import hubHero from '../presets/preset-gold-noise-gradient.json';
import noiseGradient from '../presets/preset-noise-gradient.json';

type Raw = Record<string, unknown>;
const layer = (id: string, type: string, extra: Raw = {}): Raw => ({ id, type, name: id, visible: true, blend: 'normal', params: {}, ...extra });
const scene = (layers: Raw[]): Raw => ({ version: 1, id: 't', size: { mode: 'fill' }, background: '#000000', fps: 60, dpr: [1, 1.75], layers });

function read(raw: Raw): { scene: SceneConfig; notes: string[] } {
  const r = parseFxScene(raw);
  if (!r.ok) throw new Error(r.message);
  return r;
}
const targetOf = (s: SceneConfig, id: string) => s.layers.find((l) => l.id === id)?.target;

// Two content layers, three effects.
const base = (): Raw[] => [layer('g', 'gradient'), layer('n', 'noiseFill'), layer('px', 'pixelate', { target: 'n' })];

describe('the reader and a target', () => {
  it('keeps a target that names a content layer, and writes it back', () => {
    const r = read(scene(base()));
    expect(targetOf(r.scene, 'px')).toBe('n');
    expect(r.notes).toEqual([]);
    const again = read(serializeScene(r.scene) as unknown as Raw);
    expect(targetOf(again.scene, 'px')).toBe('n');
  });

  it('writes no target field for a layer without one', () => {
    const r = read(scene(base()));
    const written = serializeScene(r.scene).layers;
    expect(written.find((l) => l.id === 'n')).not.toHaveProperty('target');
    expect(written.find((l) => l.id === 'px')).toHaveProperty('target', 'n');
  });

  it.each([
    ['a target that is not a layer of the scene', [layer('n', 'noiseFill'), layer('px', 'pixelate', { target: 'gone' })], 'px', 'not a layer of this scene'],
    ['a target that is an effect', [layer('n', 'noiseFill'), layer('b', 'bloom'), layer('px', 'pixelate', { target: 'b' })], 'px', 'not a content layer'],
    ['the effect itself', [layer('n', 'noiseFill'), layer('px', 'pixelate', { target: 'px' })], 'px', 'the effect itself'],
    ['a content layer with a target', [layer('n', 'noiseFill'), layer('g', 'gradient', { target: 'n' })], 'g', 'only an effect'],
  ])('drops %s, with a note, so the effect applies to the whole scene', (_name, layers, id, why) => {
    const r = read(scene(layers as Raw[]));
    expect(targetOf(r.scene, id)).toBeUndefined();
    expect(r.notes.join(' ')).toContain(why);
  });

  it('drops a target that is not a string', () => {
    const r = read(scene([layer('n', 'noiseFill'), layer('px', 'pixelate', { target: 7 })]));
    expect(targetOf(r.scene, 'px')).toBeUndefined();
    expect(r.notes.join(' ')).toContain('not valid');
  });

  it('gives an effect that reads its own layer (god rays) no target', () => {
    const r = read(scene([layer('t', 'text'), layer('n', 'noiseFill'), layer('r', 'godRays', { target: 'n', params: { sourceLayerId: 't' } })]));
    expect(targetOf(r.scene, 'r')).toBeUndefined();
    expect(r.notes.join(' ')).toContain('reads its own layer');
  });

  it('drops a target that a god rays layer reads, so the sun stays in the main picture', () => {
    const r = read(scene([layer('t', 'text'), layer('r', 'godRays', { params: { sourceLayerId: 't' } }), layer('px', 'pixelate', { target: 't' })]));
    expect(targetOf(r.scene, 'px')).toBeUndefined();
    expect(r.notes.join(' ')).toContain('god rays');
  });

  it(`allows effects on up to ${FX_LIMITS.targetedLayers} layers and drops the rest, never refusing the scene`, () => {
    const contents = ['a', 'b', 'c', 'd', 'e'].map((id) => layer(id, 'shape'));
    const effects = ['a', 'b', 'c', 'd', 'e'].map((id) => layer(`fx-${id}`, 'pixelate', { target: id }));
    const extra = layer('fx-a2', 'grain', { target: 'a' });
    const r = read(scene([...contents, ...effects, extra]));
    const kept = r.scene.layers.filter((l) => l.target !== undefined).map((l) => l.id);
    expect(kept).toEqual(['fx-a', 'fx-b', 'fx-c', 'fx-d', 'fx-a2']);
    expect(r.notes.join(' ')).toContain(`at most ${FX_LIMITS.targetedLayers}`);
  });

  it('keeps the target of a hidden layer (hiding is a runtime state)', () => {
    const raw = base();
    (raw[1] as Raw).visible = false;
    expect(targetOf(read(scene(raw)).scene, 'px')).toBe('n');
  });

  it("the engine's own loader reads and settles the same way", () => {
    const loaded = deserializeScene(scene([...base(), layer('bad', 'grain', { target: 'gone' })]));
    expect(targetOf(loaded, 'px')).toBe('n');
    expect(targetOf(loaded, 'bad')).toBeUndefined();
  });
});

// The planner as it was before targets existed.
function legacyPlan(layers: readonly Layer[], perfLow: boolean, isMounted: (id: string) => boolean) {
  const sourceOf = (l: Layer) => (l.params.sourceLayerId && l.params.sourceLayerId.type === 'select' ? l.params.sourceLayerId.value : null);
  const live = layers.filter((l) => {
    if (!l.visible) return false;
    const schema = getLayerSchema(l.type);
    return schema !== undefined && !(perfLow && schema.heavy);
  });
  const content = live.filter((l) => getLayerSchema(l.type)?.kind === 'content');
  const ids = new Set(content.map((l) => l.id));
  const post = live.filter((l) => getLayerSchema(l.type)?.kind === 'post' && (sourceOf(l) === null || ids.has(sourceOf(l)!)));
  const postReady = post.every((l) => sourceOf(l) === null || isMounted(sourceOf(l)!));
  return { content, post, postReady };
}

describe('planPipeline without a target', () => {
  const scenes = [v7, hubHero, godrays, noiseGradient, bokeh].map((s) => deserializeScene(s).layers);
  it.each(scenes.map((s, i) => [i, s] as const))('plans scene %i exactly as before, in every state', (_i, layers) => {
    for (const perfLow of [false, true]) {
      for (const mounted of [() => true, () => false]) {
        const now = planPipeline(layers, perfLow, mounted);
        expect(now.groups).toEqual([]);
        expect({ content: now.content, post: now.post, postReady: now.postReady }).toEqual(legacyPlan(layers, perfLow, mounted));
      }
      const hidden = layers.map((l, i) => (i % 2 ? { ...l, visible: false } : l));
      const now = planPipeline(hidden, perfLow, () => true);
      expect({ content: now.content, post: now.post, postReady: now.postReady }).toEqual(legacyPlan(hidden, perfLow, () => true));
    }
  });
});

describe('planPipeline with targets', () => {
  const layers = (mutate: (raw: Raw[]) => void = () => {}): Layer[] => {
    const raw = [layer('g', 'gradient'), layer('n', 'noiseFill'), layer('s', 'shape'), layer('px', 'pixelate', { target: 'n' }), layer('gr', 'grain', { target: 'n' }), layer('vg', 'vignette', { target: 's' }), layer('bl', 'bloom')];
    mutate(raw);
    return read(scene(raw)).scene.layers;
  };
  const all = () => true;

  it('moves targeted effects into their group, in stored order, and keeps the others scene-wide', () => {
    const plan = planPipeline(layers(), false, all);
    expect(plan.post.map((l) => l.id)).toEqual(['bl']);
    expect(plan.groups.map((g) => [g.target.id, g.channel, g.effects.map((l) => l.id)])).toEqual([
      ['n', 1, ['px', 'gr']],
      ['s', 2, ['vg']],
    ]);
  });

  it('leaves out the effects of a hidden target, never running them scene-wide', () => {
    const plan = planPipeline(layers((raw) => ((raw[1] as Raw).visible = false)), false, all);
    expect(plan.groups.map((g) => g.target.id)).toEqual(['s']);
    expect(plan.post.map((l) => l.id)).toEqual(['bl']);
  });

  it('leaves out a hidden effect, and drops a group that has no effect left', () => {
    const plan = planPipeline(layers((raw) => ((raw[5] as Raw).visible = false)), false, all);
    expect(plan.groups.map((g) => g.target.id)).toEqual(['n']);
  });

  it('drops heavy effects of a group on the step down and the group when none is left', () => {
    const heavy = layers((raw) => {
      raw.push(layer('bk', 'bokeh', { target: 'g' }));
    });
    expect(getLayerSchema('bokeh')?.heavy).toBe(true);
    expect(planPipeline(heavy, false, all).groups.map((g) => g.target.id)).toEqual(['g', 'n', 's']);
    const down = planPipeline(heavy, true, all);
    expect(down.groups.map((g) => g.target.id)).toEqual(['n', 's']);
    expect(down.post.map((l) => l.id)).not.toContain('bk');
  });
});
