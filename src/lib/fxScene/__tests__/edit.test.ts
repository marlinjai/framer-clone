// @vitest-environment node
// Every change the editor makes to an FX scene (../edit): each one alone, what the
// strict reader does to its result, and the four paths of a flow with state: forward,
// going back and changing an earlier choice, a reload, and starting again.

import { describe, expect, it } from 'vitest';

import { FX_LIMITS, PRESETS, serializeScene } from '@/lib/fx/format';
import {
  FX_DEFAULT_PRESET,
  addFxLayer,
  applyFxPreset,
  fxFromPreset,
  fxPresetOptions,
  fxSceneJson,
  importFxScene,
  moveFxLayer,
  removeFxLayer,
  renameFxLayer,
  setFxBackground,
  setFxCalm,
  setFxLayerBlend,
  setFxLayerType,
  setFxParam,
  setFxStart,
  toggleFxLayer,
  type FxEdit,
} from '../edit';
import { parseFxProp } from '../fxScene';

const SITE_IMAGE = `/site-images/${'a'.repeat(64)}.png`;

function ok(edit: FxEdit): Extract<FxEdit, { ok: true }> {
  if (!edit.ok) throw new Error(`expected a change, got: ${edit.message}`);
  return edit;
}
function refused(edit: FxEdit): string {
  if (edit.ok) throw new Error('expected a refusal');
  return edit.message;
}
/** A reload: what is stored goes through JSON and comes back. */
const reload = <T,>(stored: T): T => JSON.parse(JSON.stringify(stored)) as T;
const start = (preset = 'godrays-hero') => ok(fxFromPreset(preset)).stored;
const layers = (stored: unknown) => (stored as { scene: { layers: Array<{ id: string; type: string; visible: boolean; blend: string; name: string; params: Record<string, unknown> }> } }).scene.layers;
const layer = (stored: unknown, id: string) => layers(stored).find((l) => l.id === id)!;

describe('a new scene', () => {
  it('starts from the lumitra.co hero, as lumitra.co starts it, with lumitra.co\'s painted background', () => {
    const made = fxFromPreset();
    if (!made.ok) throw new Error(made.message);
    expect(FX_DEFAULT_PRESET).toBe('gold-noise-gradient');
    expect(made.stored).toMatchObject({ version: 1, start: 'settled', calm: 'background' });
    expect(made.stored.scene.id).toBe('lumitra-hub-hero');
    expect(made.notes).toEqual([]);
    expect(made.background).toMatch(/^radial-gradient\(60% 50% at 20% 15%, rgba\(201, 160, 74, 0\.28\)/);
    expect(made.background.endsWith('#000000')).toBe(true);
  });

  it('gives every preset a scene the reader accepts unchanged, and a background', () => {
    expect(fxPresetOptions().map((p) => p.id)).toEqual(PRESETS.map((p) => p.id));
    for (const preset of fxPresetOptions()) {
      const made = fxFromPreset(preset.id);
      if (!made.ok) throw new Error(made.message);
      expect(made.notes, preset.id).toEqual([]);
      expect(made.stored.scene).toEqual(serializeScene(PRESETS.find((p) => p.id === preset.id)!.load()));
      expect(parseFxProp(reload(made.stored)).ok).toBe(true);
      expect(made.background.length).toBeGreaterThan(0);
      // No address in a fallback background: nothing is fetched for it.
      expect(made.background).not.toMatch(/url\(/);
    }
  });

  it('refuses an unknown preset', () => {
    expect(fxFromPreset('nope')).toEqual({ ok: false, message: 'There is no FX preset called "nope".' });
  });
});

describe('each change', () => {
  it('sets when the scene starts and what reduced motion shows, and refuses what is neither', () => {
    const stored = start();
    expect(ok(setFxStart(stored, 'visible')).stored.start).toBe('visible');
    expect(ok(setFxCalm(stored, 'frame')).stored.calm).toBe('frame');
    expect(refused(setFxStart(stored, 'now' as never))).toMatch(/not a way to start/);
    expect(refused(setFxCalm(stored, 'video' as never))).toMatch(/not a reduced motion setting/);
  });

  it('sets a number inside its range, and clamps one outside it with a note', () => {
    const stored = start();
    const bloom = layers(stored).find((l) => l.type === 'bloom')!;
    const key = Object.keys(bloom.params).find((k) => typeof bloom.params[k] === 'number')!;
    const inside = ok(setFxParam(stored, bloom.id, key, bloom.params[key] as number));
    expect(inside.notes).toEqual([]);
    const outside = ok(setFxParam(stored, bloom.id, key, 1e9));
    expect(outside.notes).toHaveLength(1);
    expect(layer(outside.stored, bloom.id).params[key]).toBeLessThan(1e9);
  });

  it('sets a colour, a choice and text, and falls back to the default for a value of the wrong kind', () => {
    const stored = start();
    const text = layers(stored).find((l) => l.type === 'text')!;
    expect(layer(ok(setFxParam(stored, text.id, 'color', '#ff8800')).stored, text.id).params.color).toBe('#ff8800');
    expect(layer(ok(setFxParam(stored, text.id, 'headlineWeight', '700')).stored, text.id).params.headlineWeight).toBe('700');
    expect(layer(ok(setFxParam(stored, text.id, 'headlineText', 'Bäckerei Krause')).stored, text.id).params.headlineText).toBe('Bäckerei Krause');
    const bad = ok(setFxParam(stored, text.id, 'color', 'url(https://evil.example)'));
    expect(layer(bad.stored, text.id).params.color).not.toContain('evil');
    expect(bad.notes).toHaveLength(1);
  });

  it('refuses a setting or a layer that is not there, and leaves no trace', () => {
    const stored = start();
    const before = JSON.stringify(stored);
    expect(refused(setFxParam(stored, 'missing', 'x', 1))).toBe('That layer is no longer in the scene.');
    expect(refused(setFxParam(stored, layers(stored)[0].id, 'nope', 1))).toMatch(/no setting called "nope"/);
    for (const edit of [removeFxLayer(stored, 'missing'), moveFxLayer(stored, 'missing', 1), toggleFxLayer(stored, 'missing'), renameFxLayer(stored, 'missing', 'x'), setFxLayerBlend(stored, 'missing', 'screen'), setFxLayerType(stored, 'missing', 'grain')]) {
      expect(refused(edit)).toBe('That layer is no longer in the scene.');
    }
    expect(JSON.stringify(stored)).toBe(before);
  });

  it('adds a layer at the front with its defaults under a new id, and refuses an unknown kind', () => {
    const stored = start();
    const added = addFxLayer(stored, 'grain');
    if (!added.ok) throw new Error(added.message);
    expect(layers(added.stored)).toHaveLength(layers(stored).length + 1);
    expect(layers(added.stored).at(-1)).toMatchObject({ id: added.layerId, type: 'grain', visible: true, blend: 'normal' });
    const again = addFxLayer(added.stored, 'grain');
    if (!again.ok) throw new Error(again.message);
    expect(again.layerId).not.toBe(added.layerId);
    expect(refused(addFxLayer(stored, 'customShader'))).toMatch(/not a kind of layer/);
  });

  it('refuses one layer more than a scene may hold', () => {
    let stored: unknown = start();
    while (layers(stored).length < FX_LIMITS.layers) stored = ok(addFxLayer(stored, 'vignette')).stored;
    expect(refused(addFxLayer(stored, 'vignette'))).toMatch(new RegExp(`at most ${FX_LIMITS.layers} layers`));
  });

  it('removes, moves, hides, renames and blends one layer and leaves the others as they were', () => {
    const stored = start();
    const ids = layers(stored).map((l) => l.id);
    expect(layers(ok(removeFxLayer(stored, ids.at(-1)!)).stored).map((l) => l.id)).toEqual(ids.slice(0, -1));
    expect(layers(ok(moveFxLayer(stored, ids.at(-1)!, -1)).stored).map((l) => l.id)).toEqual([...ids.slice(0, -2), ids.at(-1), ids.at(-2)]);
    expect(layers(ok(moveFxLayer(stored, ids.at(-1)!, 1)).stored).map((l) => l.id)).toEqual(ids);
    const hidden = ok(toggleFxLayer(stored, ids.at(-1)!)).stored;
    expect(layer(hidden, ids.at(-1)!).visible).toBe(false);
    expect(layers(hidden).slice(0, -1)).toEqual(layers(stored).slice(0, -1));
    expect(layer(ok(renameFxLayer(stored, ids[0], 'Backdrop')).stored, ids[0]).name).toBe('Backdrop');
    expect(layer(ok(setFxLayerBlend(stored, ids[0], 'screen')).stored, ids[0]).blend).toBe('screen');
    expect(layer(ok(setFxLayerBlend(stored, ids[0], 'difference' as never)).stored, ids[0]).blend).toBe('normal');
  });

  it('sets the scene background to a colour and to nothing else', () => {
    const stored = start();
    expect(ok(setFxBackground(stored, '#102030')).stored.scene.background).toBe('#102030');
    const bad = ok(setFxBackground(stored, 'url(https://evil.example/x.png)'));
    expect(bad.stored.scene.background).toBe('#000000');
    expect(bad.notes).toHaveLength(1);
  });

  it('accepts an image a site stores for an image layer and refuses any other address, changing nothing', () => {
    const withImage = addFxLayer(start(), 'image');
    if (!withImage.ok) throw new Error(withImage.message);
    const id = withImage.layerId!;
    expect(layer(ok(setFxParam(withImage.stored, id, 'src', SITE_IMAGE)).stored, id).params.src).toBe(SITE_IMAGE);
    const before = JSON.stringify(withImage.stored);
    expect(refused(setFxParam(withImage.stored, id, 'src', 'https://evil.example/x.png'))).toMatch(/only show an image uploaded to this site/);
    expect(JSON.stringify(withImage.stored)).toBe(before);
  });
});

describe('a change with consequences elsewhere in the scene', () => {
  it('removing the layer god rays read from moves them to another content layer, and says so', () => {
    const stored = start('godrays-hero');
    const rays = layers(stored).find((l) => l.type === 'godRays')!;
    const source = rays.params.sourceLayerId as string;
    const removed = ok(removeFxLayer(stored, source));
    const moved = layer(removed.stored, rays.id).params.sourceLayerId as string;
    expect(moved).not.toBe(source);
    expect(layers(removed.stored).some((l) => l.id === moved)).toBe(true);
    expect(removed.notes).toEqual([expect.stringMatching(/read from a layer that is not in this scene/)]);
    // Undo is the prop from before: nothing of the change is left in it.
    expect(layer(stored, rays.id).params.sourceLayerId).toBe(source);
  });

  it('a box whose scene is refused or missing gets a way forward: a preset', () => {
    for (const broken of [undefined, null, 'x', { version: 9 }, { version: 1, scene: { layers: 'no' } }]) {
      expect(setFxStart(broken, 'visible').ok).toBe(false);
      const fresh = ok(applyFxPreset(broken, 'noise-gradient'));
      expect(fresh.stored).toMatchObject({ version: 1, start: 'settled', calm: 'background' });
      expect(fresh.stored.scene.id).toBe('lumitra-preset-noise-gradient');
    }
  });
});

describe('copying and importing a scene', () => {
  it('copies exactly what is stored, and importing the copy changes nothing', () => {
    const stored = ok(setFxCalm(start(), 'frame')).stored;
    const text = fxSceneJson(stored)!;
    expect(JSON.parse(text)).toEqual(stored.scene);
    const imported = ok(importFxScene(stored, JSON.parse(text)));
    expect(imported.stored).toEqual(stored);
    expect(imported.notes).toEqual([]);
  });

  it('imports another scene and keeps when it starts and what reduced motion shows', () => {
    const stored = ok(setFxCalm(ok(setFxStart(start('godrays-hero'), 'visible')).stored, 'frame')).stored;
    const other = start('noise-gradient').scene;
    const imported = ok(importFxScene(stored, other));
    expect(imported.stored).toEqual({ version: 1, scene: other, start: 'visible', calm: 'frame' });
  });

  it('refuses what is not a scene, a scene with a foreign image and one with too many layers, changing nothing', () => {
    const stored = start();
    expect(refused(importFxScene(stored, 'x'))).toMatch(/empty or not a scene/);
    expect(refused(importFxScene(stored, { id: 'x' }))).toMatch(/no list of layers/);
    const foreign = { ...stored.scene, layers: [...stored.scene.layers, { id: 'pic', type: 'image', name: 'Pic', visible: true, blend: 'normal', params: { src: 'https://evil.example/x.png' } }] };
    expect(refused(importFxScene(stored, foreign))).toMatch(/only show an image uploaded to this site/);
    expect(fxSceneJson('nothing')).toBeNull();
  });

  it('reports what the reader repaired in an imported scene', () => {
    const stored = start();
    const messy = { ...stored.scene, background: 'red', layers: [...stored.scene.layers, { id: 'x', type: 'customShader' }] };
    const imported = ok(importFxScene(stored, messy));
    expect(imported.notes).toHaveLength(2);
    expect(imported.stored.scene.layers).toHaveLength(stored.scene.layers.length);
  });
});

describe('the four paths of changing a layer\'s kind', () => {
  // The choice is the layer's kind; what derives from it is the layer's settings.
  const setup = () => {
    const stored = start('godrays-hero');
    const vignette = layers(stored).find((l) => l.type === 'vignette')!;
    const key = Object.keys(vignette.params).find((k) => typeof vignette.params[k] === 'number')!;
    const tuned = ok(setFxParam(stored, vignette.id, key, (vignette.params[key] as number) * 0.5)).stored;
    return { tuned, vignetteId: vignette.id, key, others: layers(tuned).filter((l) => l.id !== vignette.id) };
  };

  it('forward: the layer becomes the new kind with that kind\'s defaults, in its place, and the others are untouched', () => {
    const { tuned, vignetteId, others } = setup();
    const at = layers(tuned).findIndex((l) => l.id === vignetteId);
    const changed = setFxLayerType(tuned, vignetteId, 'grain');
    if (!changed.ok) throw new Error(changed.message);
    const now = layers(changed.stored)[at];
    expect(now.type).toBe('grain');
    expect(now.id).toBe(changed.layerId);
    expect(now.params).toEqual(layers(ok(addFxLayer(start('noise-gradient'), 'grain')).stored).at(-1)!.params);
    expect(Object.keys(now.params)).not.toContain(Object.keys(layer(tuned, vignetteId).params)[0]);
    expect(layers(changed.stored).filter((_, i) => i !== at)).toEqual(others);
  });

  it('back and revise: choosing another kind discards the settings made for the first, and choosing the same kind keeps them', () => {
    const { tuned, vignetteId, key } = setup();
    // The same kind again: nothing derived is thrown away.
    const same = setFxLayerType(tuned, vignetteId, 'vignette');
    if (!same.ok) throw new Error(same.message);
    expect(same.stored).toEqual(tuned);
    expect(same.layerId).toBe(vignetteId);
    // Another kind, then back to the first: the tuned value is gone, the default is back.
    const away = setFxLayerType(tuned, vignetteId, 'grain');
    if (!away.ok) throw new Error(away.message);
    const back = setFxLayerType(away.stored, away.layerId!, 'vignette');
    if (!back.ok) throw new Error(back.message);
    // The kind's own default, as on a vignette added new (not the preset's value either: that was tuning too).
    const fresh = layers(ok(addFxLayer(start('noise-gradient'), 'vignette')).stored).at(-1)!.params[key];
    expect(layer(back.stored, back.layerId!).params[key]).toBe(fresh);
    expect(layer(back.stored, back.layerId!).params[key]).not.toBe(layer(tuned, vignetteId).params[key]);
  });

  it('resume: after a reload the scene is the same, and the next change builds on it', () => {
    const { tuned, vignetteId, key } = setup();
    const restored = reload(tuned);
    const read = parseFxProp(restored);
    if (!read.ok) throw new Error(read.message);
    expect(read.notes).toEqual([]);
    expect(layer(restored, vignetteId).params[key]).toBe(layer(tuned, vignetteId).params[key]);
    const next = ok(toggleFxLayer(restored, vignetteId));
    expect(layer(next.stored, vignetteId).params[key]).toBe(layer(tuned, vignetteId).params[key]);
    // A stored scene from before a layer kind existed, or damaged: the reload does not bring a stale layer back.
    const damaged = reload(tuned) as unknown as { scene: { layers: Array<Record<string, unknown>> } };
    damaged.scene.layers.push({ id: 'old', type: 'retiredKind', params: { amount: 3 } });
    const repaired = ok(toggleFxLayer(damaged, vignetteId));
    expect(layers(repaired.stored).some((l) => l.id === 'old')).toBe(false);
  });

  it('re-entry: a preset chosen again starts clean, with nothing of the earlier tuning', () => {
    const { tuned } = setup();
    const again = ok(applyFxPreset(tuned, 'godrays-hero'));
    expect(again.stored.scene).toEqual(start('godrays-hero').scene);
    const moved = ok(applyFxPreset(ok(setFxCalm(tuned, 'frame')).stored, 'noise-gradient'));
    // What is not the scene's survives a new preset: when it starts and what reduced motion shows.
    expect(moved.stored.calm).toBe('frame');
    expect(moved.stored.scene).toEqual(start('noise-gradient').scene);
  });
});
