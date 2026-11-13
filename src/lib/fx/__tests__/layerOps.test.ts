// @vitest-environment node
// The layer list operations the Layers panel's rows call through: moving a layer WITHIN its
// group (content among content, post effects among post effects, never across), and
// duplicating a layer. Pure functions over the scene's layer array; nothing mounts or draws.

import { describe, expect, it } from 'vitest';

import '../builtins';
import { duplicateLayer, instantiateLayer, moveLayerTo, placeInGroup } from '../layerOps';
import { findPreset } from '../presets';
import { getLayerSchema } from '../registry';
import type { Layer } from '../types';

const hero = (): Layer[] => findPreset('gold-noise-gradient')!.load().layers;
const ids = (layers: Layer[]) => layers.map((l) => l.id);
const kindOf = (l: Layer) => getLayerSchema(l.type)!.kind;

/** Content, post, content, post: the two groups interleaved in the stored array. */
function interleaved(): Layer[] {
  const out: Layer[] = [];
  for (const type of ['gradient', 'bloom', 'noiseFill', 'vignette', 'shape']) out.push(instantiateLayer(type, out)!);
  return out;
}

describe('moveLayerTo: within a group, never across', () => {
  it('moves a post effect among the post effects and leaves every content slot where it was', () => {
    const layers = interleaved();
    const [gradient, bloom, noise, vignette, shape] = layers;
    // Post effects in stored order: bloom, vignette. Move bloom to the front of its group.
    const moved = moveLayerTo(layers, bloom.id, 1);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(ids(moved.layers)).toEqual([gradient.id, vignette.id, noise.id, bloom.id, shape.id]);
    // The content layers did not move at all.
    expect(moved.layers.filter((l) => kindOf(l) === 'content').map((l) => l.id)).toEqual([gradient.id, noise.id, shape.id]);
  });

  it('moves a content layer among the content layers and leaves the post slots alone', () => {
    const layers = interleaved();
    const [gradient, bloom, noise, vignette, shape] = layers;
    const moved = moveLayerTo(layers, gradient.id, 2);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(ids(moved.layers)).toEqual([noise.id, bloom.id, shape.id, vignette.id, gradient.id]);
  });

  it('refuses the edges of the group, with the layer named, and a move to where it already is', () => {
    const layers = interleaved();
    const bloom = layers[1];
    const edge = moveLayerTo(layers, bloom.id, -1);
    expect(edge).toEqual({ ok: false, reason: `${bloom.name} is already at the back of its group.` });
    const past = moveLayerTo(layers, bloom.id, 2);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toMatch(/front of its group/);
    expect(moveLayerTo(layers, bloom.id, 0).ok).toBe(false);
    expect(moveLayerTo(layers, 'nope', 0)).toEqual({ ok: false, reason: 'That layer is no longer in the scene.' });
    expect(moveLayerTo(layers, bloom.id, 0.5).ok).toBe(false);
  });

  it('does not change the input array', () => {
    const layers = interleaved();
    const before = ids(layers);
    moveLayerTo(layers, layers[1].id, 1);
    expect(ids(layers)).toEqual(before);
  });

  it('placeInGroup counts inside the layer\'s own group', () => {
    const layers = interleaved();
    expect(placeInGroup(layers, layers[1].id)).toEqual({ index: 0, size: 2 });
    expect(placeInGroup(layers, layers[4].id)).toEqual({ index: 2, size: 3 });
    expect(placeInGroup(layers, 'nope')).toBeNull();
  });
});

describe('duplicateLayer', () => {
  it('makes a copy with a new id and a name that says so, directly in front of the original, sharing nothing', () => {
    const layers = hero();
    const bloom = layers.find((l) => l.type === 'bloom')!;
    const copied = duplicateLayer(layers, bloom.id, 16);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.layers).toHaveLength(layers.length + 1);
    const at = copied.layers.findIndex((l) => l.id === bloom.id);
    const copy = copied.layers[at + 1];
    expect(copy.id).toBe(copied.layerId);
    expect(copy.id).not.toBe(bloom.id);
    expect(new Set(ids(copied.layers)).size).toBe(copied.layers.length);
    expect(copy.name).toBe(`${bloom.name} copy`);
    expect(copy.type).toBe('bloom');
    expect(copy.params).toEqual(bloom.params);
    expect(copy.params).not.toBe(bloom.params);
    // Editing the copy's settings never reaches the original.
    copy.params.intensity.value = 123 as never;
    expect(bloom.params.intensity.value).not.toBe(123);
  });

  it('is refused at the layer limit, and for a layer that is gone', () => {
    const layers = hero();
    const full = duplicateLayer(layers, layers[0].id, layers.length);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.reason).toMatch(new RegExp(`at most ${layers.length} layers`));
    expect(duplicateLayer(layers, 'nope', 16).ok).toBe(false);
  });

  it('cuts a long name to the name limit', () => {
    const layers = hero();
    layers[0] = { ...layers[0], name: 'x'.repeat(80) };
    const copied = duplicateLayer(layers, layers[0].id, 16, 80);
    expect(copied.ok && copied.layers[1].name).toHaveLength(80);
  });
});
