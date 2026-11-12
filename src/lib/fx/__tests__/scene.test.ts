// @vitest-environment node
// The engine's pure scene functions: the layer list operations the Sites
// properties panel builds on, the immutable parameter update behind
// createScene().setParam, and the loaders against lumitra.co's real hero scene.
// Nothing here mounts a component or touches WebGL.

import { describe, expect, it } from 'vitest';

import '../builtins';
import { withParam } from '../createScene';
import { appendLayer, instantiateLayer, listAddableTypes, moveLayer, removeLayer, toggleLayer, withLayers } from '../layerOps';
import { PRESETS, findPreset } from '../presets';
import { getLayerDefinition, listLayerDefinitions } from '../registry';
import { deserializeScene, sceneToJSON, serializeScene } from '../serialize';
import { SCENE_SCHEMA_VERSION } from '../types';

import hubHeroJson from '../presets/preset-gold-noise-gradient.json';

const BUILT_IN_TYPES = [
  'bloom',
  'bokeh',
  'chromaticAberration',
  'distortion',
  'godRays',
  'gradient',
  'grain',
  'halftone',
  'image',
  'noiseFill',
  'pixelate',
  'rgbShift',
  'shape',
  'text',
  'vignette',
];

describe('the built-in registry', () => {
  it('registers exactly the 15 layer types of the plan', () => {
    expect(listLayerDefinitions().map((d) => d.type).sort()).toEqual(BUILT_IN_TYPES);
  });

  it('lists content types before post passes in the add picker', () => {
    const kinds = listAddableTypes().map((t) => t.kind);
    expect(kinds.slice(0, 5)).toEqual(Array(5).fill('content'));
    expect(kinds.slice(5)).toEqual(Array(10).fill('post'));
  });
});

describe('the lumitra.co hub hero scene (lumitra-web src/scenes/hub-hero.json at 8a77254)', () => {
  it('loads with every layer kept and survives a serialize round trip', () => {
    const scene = deserializeScene(hubHeroJson);
    expect(scene.version).toBe(SCENE_SCHEMA_VERSION);
    expect(scene.layers.map((l) => l.type)).toEqual((hubHeroJson as { layers: { type: string }[] }).layers.map((l) => l.type));
    for (const layer of scene.layers) expect(getLayerDefinition(layer.type)).toBeDefined();
    expect(deserializeScene(JSON.parse(sceneToJSON(scene)))).toEqual(scene);
  });

  it('drops a layer type the registry does not know', () => {
    const raw = JSON.parse(JSON.stringify(hubHeroJson)) as { layers: { id: string; type: string }[] };
    raw.layers.push({ ...raw.layers[0], id: 'evil', type: 'customShader' });
    const scene = deserializeScene(raw);
    expect(scene.layers.some((l) => l.id === 'evil')).toBe(false);
    expect(scene.layers).toHaveLength(raw.layers.length - 1);
  });
});

describe('the presets', () => {
  it('each load through the scene loader with known layer types only', () => {
    expect(PRESETS.map((p) => p.id).sort()).toEqual(['bokeh-focuspull', 'godrays-hero', 'gold-noise-gradient', 'noise-gradient']);
    for (const meta of PRESETS) {
      expect(findPreset(meta.id)).toBe(meta);
      const scene = meta.load();
      expect(scene.layers.length).toBeGreaterThan(0);
      expect(deserializeScene(serializeScene(scene))).toEqual(scene);
      for (const layer of scene.layers) expect(BUILT_IN_TYPES).toContain(layer.type);
    }
  });
});

describe('layer list operations', () => {
  const base = () => deserializeScene(hubHeroJson);

  it('instantiateLayer mints registry defaults under a unique id and does not alias them', () => {
    const scene = base();
    const first = instantiateLayer('gradient', scene.layers)!;
    const second = instantiateLayer('gradient', [...scene.layers, first])!;
    expect(first.id).not.toBe(second.id);
    expect(new Set([...scene.layers, first, second].map((l) => l.id)).size).toBe(scene.layers.length + 2);
    expect(first.visible).toBe(true);
    expect(first.blend).toBe('normal');

    const defaults = getLayerDefinition('gradient')!.defaultParams;
    const key = Object.keys(defaults)[0];
    const before = JSON.stringify(defaults[key]);
    (first.params[key] as { value: unknown }).value = 'changed';
    expect(JSON.stringify(defaults[key])).toBe(before);
    expect(JSON.stringify(second.params[key])).toBe(before);
  });

  it('instantiateLayer refuses an unknown type', () => {
    expect(instantiateLayer('customShader', [])).toBeNull();
  });

  it('moveLayer moves by one slot and leaves the list alone at either end or for an unknown id', () => {
    const { layers } = base();
    expect(layers.length).toBeGreaterThan(1);
    const ids = layers.map((l) => l.id);
    expect(moveLayer(layers, ids[0], 1).map((l) => l.id)).toEqual([ids[1], ids[0], ...ids.slice(2)]);
    expect(moveLayer(layers, ids[0], -1)).toBe(layers);
    expect(moveLayer(layers, ids[ids.length - 1], 1)).toBe(layers);
    expect(moveLayer(layers, 'missing', 1)).toBe(layers);
    expect(layers.map((l) => l.id)).toEqual(ids);
  });

  it('remove, toggle and append return new lists and keep the input', () => {
    const { layers } = base();
    const ids = layers.map((l) => l.id);
    expect(removeLayer(layers, ids[0]).map((l) => l.id)).toEqual(ids.slice(1));
    const toggled = toggleLayer(layers, ids[0]);
    expect(toggled[0].visible).toBe(!layers[0].visible);
    expect(toggled.slice(1)).toEqual(layers.slice(1));
    const extra = instantiateLayer('grain', layers)!;
    expect(appendLayer(layers, extra)).toHaveLength(layers.length + 1);
    expect(layers.map((l) => l.id)).toEqual(ids);
  });

  it('withLayers replaces only the layers', () => {
    const scene = base();
    const next = withLayers(scene, []);
    expect(next.layers).toEqual([]);
    expect({ ...next, layers: scene.layers }).toEqual(scene);
  });
});

describe('withParam', () => {
  it('returns a new scene with one value replaced, metadata kept, and the input untouched', () => {
    const scene = deserializeScene(hubHeroJson);
    const layer = scene.layers[0];
    const [key, schema] = Object.entries(layer.params).find(([, s]) => s.type === 'number')!;
    const snapshot = JSON.stringify(scene);

    const next = withParam(scene, layer.id, key, 0.123)!;
    expect(next).not.toBe(scene);
    expect(next.layers[0]).not.toBe(layer);
    expect(next.layers[0].params[key]).toEqual({ ...schema, value: 0.123 });
    expect(next.layers.slice(1)).toEqual(scene.layers.slice(1));
    // Untouched layers keep their identity, so their components do not re-render.
    for (let i = 1; i < scene.layers.length; i++) expect(next.layers[i]).toBe(scene.layers[i]);
    expect(JSON.stringify(scene)).toBe(snapshot);
  });

  it('returns null for an unknown layer or parameter', () => {
    const scene = deserializeScene(hubHeroJson);
    expect(withParam(scene, 'missing', 'x', 1)).toBeNull();
    expect(withParam(scene, scene.layers[0].id, 'no-such-param', 1)).toBeNull();
  });
});
