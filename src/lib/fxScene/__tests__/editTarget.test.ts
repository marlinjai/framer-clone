// The edit paths of effects that apply to one content layer (`target`), and of the pointer
// settings. Each case would otherwise silently make a scoped effect scene-wide (the strict reader
// drops a target it cannot keep), so every one asserts the target afterwards.
import { describe, expect, it } from 'vitest';
import {
  addFxLayer,
  applyFxPreset,
  duplicateFxLayer,
  fxFromPreset,
  importFxScene,
  removeFxLayer,
  setFxLayerInteractivity,
  setFxLayerTarget,
  setFxLayerType,
  setFxParam,
  stepFxLayer,
  type FxEdit,
} from '../edit';
import { parseFxProp } from '../fxScene';

type L = { id: string; type: string; name: string; target?: string; params: Record<string, unknown>; interactivity?: Record<string, unknown> };
const ok = <E extends FxEdit>(e: E): Extract<E, { ok: true }> => {
  if (!e.ok) throw new Error(`expected a change, got: ${e.message}`);
  return e as Extract<E, { ok: true }>;
};
const refused = (e: FxEdit): string => {
  if (e.ok) throw new Error('expected a refusal');
  return e.message;
};
const layers = (stored: unknown) => (stored as { scene: { layers: L[] } }).scene.layers;
const byType = (stored: unknown, type: string) => layers(stored).filter((l) => l.type === type);
const reload = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** gold preset: gradient + noiseFill (content), bloom + vignette + grain (post). Bloom is scoped to the gradient. */
function scoped() {
  const base = ok(fxFromPreset('gold-noise-gradient')).stored;
  const gradient = byType(base, 'gradient')[0].id;
  const bloom = byType(base, 'bloom')[0].id;
  const stored = ok(setFxLayerTarget(base, bloom, gradient)).stored;
  return { stored, gradient, bloom, noise: byType(base, 'noiseFill')[0].id, vignette: byType(base, 'vignette')[0].id, grain: byType(base, 'grain')[0].id };
}
const targetOf = (stored: unknown, id: string) => layers(stored).find((l) => l.id === id)?.target;

describe('setFxLayerTarget', () => {
  it('scopes an effect to a content layer and back to the whole scene, one stored value each', () => {
    const s = scoped();
    expect(targetOf(s.stored, s.bloom)).toBe(s.gradient);
    const cleared = ok(setFxLayerTarget(s.stored, s.bloom, null));
    expect(targetOf(cleared.stored, s.bloom)).toBeUndefined();
    expect('target' in layers(cleared.stored).find((l) => l.id === s.bloom)!).toBe(false);
    // changing the target
    expect(targetOf(ok(setFxLayerTarget(s.stored, s.bloom, s.noise)).stored, s.bloom)).toBe(s.noise);
  });
  it('refuses a content layer, an unknown layer, an effect target, a missing target', () => {
    const s = scoped();
    expect(refused(setFxLayerTarget(s.stored, s.gradient, s.noise))).toMatch(/Only an effect/);
    expect(refused(setFxLayerTarget(s.stored, 'nope', s.noise))).toMatch(/no longer in the scene/);
    expect(refused(setFxLayerTarget(s.stored, s.bloom, s.vignette))).toMatch(/not a layer that draws|is an effect/);
    expect(refused(setFxLayerTarget(s.stored, s.bloom, 'gone'))).toMatch(/no longer in the scene/);
  });
  it('refuses god rays (they read a layer of their own) and a layer some god rays read', () => {
    const s = scoped();
    const added = ok(addFxLayer(s.stored, 'godRays'));
    const rays = added.layerId!;
    expect(refused(setFxLayerTarget(added.stored, rays, s.noise))).toMatch(/reads a layer of its own/);
    const source = layers(added.stored).find((l) => l.id === rays)!.params.sourceLayerId as string;
    expect(refused(setFxLayerTarget(added.stored, s.vignette, source))).toMatch(/cannot have effects of its own/);
  });
  it('refuses a fifth distinct target and allows another effect on an already scoped layer', () => {
    let stored = scoped().stored;
    // build five content layers and five effects
    for (let i = 0; i < 4; i += 1) stored = ok(addFxLayer(stored, 'shape')).stored;
    const content = layers(stored).filter((l) => ['gradient', 'noiseFill', 'shape'].includes(l.type));
    const effects = layers(stored).filter((l) => ['bloom', 'vignette', 'grain'].includes(l.type));
    expect(content.length).toBe(6);
    stored = ok(addFxLayer(stored, 'pixelate')).stored;
    const more = layers(stored).filter((l) => ['bloom', 'vignette', 'grain', 'pixelate'].includes(l.type));
    stored = ok(setFxLayerTarget(stored, more[1].id, content[1].id)).stored;
    stored = ok(setFxLayerTarget(stored, more[2].id, content[2].id)).stored;
    stored = ok(setFxLayerTarget(stored, more[3].id, content[3].id)).stored;
    // gradient plus content[1..3] are four distinct targets now
    const halftone = ok(addFxLayer(stored, 'halftone'));
    expect(refused(setFxLayerTarget(halftone.stored, halftone.layerId!, content[4].id))).toMatch(/At most 4/);
    // a second effect on an already scoped layer is not a fifth target
    expect(targetOf(ok(setFxLayerTarget(halftone.stored, halftone.layerId!, content[1].id)).stored, halftone.layerId!)).toBe(content[1].id);
    // moving bloom's own scope frees its slot
    expect(targetOf(ok(setFxLayerTarget(stored, effects[0].id, content[4].id)).stored, effects[0].id)).toBe(content[4].id);
  });
});

describe('edits that change ids keep the target right', () => {
  it('removing the targeted layer removes its effects, with a note, never makes them scene-wide', () => {
    const s = scoped();
    const removed = ok(removeFxLayer(s.stored, s.gradient));
    expect(layers(removed.stored).some((l) => l.id === s.bloom)).toBe(false);
    expect(removed.notes.join(' ')).toMatch(/applied only to/);
    // everything else is untouched
    expect(layers(removed.stored).map((l) => l.id)).toEqual(layers(s.stored).map((l) => l.id).filter((id) => id !== s.gradient && id !== s.bloom));
  });
  it('removing the effect itself leaves the layer alone', () => {
    const s = scoped();
    expect(layers(ok(removeFxLayer(s.stored, s.bloom)).stored).some((l) => l.id === s.gradient)).toBe(true);
  });
  it('retyping the targeted layer to another content kind retargets the effects to the new id', () => {
    const s = scoped();
    const edit = setFxLayerType(s.stored, s.gradient, 'shape');
    const next = ok(edit);
    expect(next.layerId).not.toBe(s.gradient);
    expect(targetOf(next.stored, s.bloom)).toBe(next.layerId);
    expect(next.notes).toEqual([]);
  });
  it('retyping the targeted layer to an effect removes the effects that applied to it', () => {
    const s = scoped();
    const next = ok(setFxLayerType(s.stored, s.gradient, 'grain'));
    expect(layers(next.stored).some((l) => l.id === s.bloom)).toBe(false);
    expect(next.notes.join(' ')).toMatch(/applied only to/);
  });
  it('retyping a scoped effect to another effect keeps its target; to a content layer or god rays clears it', () => {
    const s = scoped();
    const next = ok(setFxLayerType(s.stored, s.bloom, 'pixelate'));
    expect(targetOf(next.stored, next.layerId!)).toBe(s.gradient);
    const content = ok(setFxLayerType(s.stored, s.bloom, 'shape'));
    expect(targetOf(content.stored, content.layerId!)).toBeUndefined();
    const rays = ok(setFxLayerType(s.stored, s.bloom, 'godRays'));
    expect(targetOf(rays.stored, rays.layerId!)).toBeUndefined();
    // and the god rays read the untargeted layer, not the scoped gradient
    expect(layers(rays.stored).find((l) => l.id === rays.layerId)!.params.sourceLayerId).not.toBe(s.gradient);
  });
  it('retyping the layer god rays read repoints them to the new layer when it stays content', () => {
    const s = scoped();
    const added = ok(addFxLayer(s.stored, 'godRays'));
    const rays = layers(added.stored).find((l) => l.id === added.layerId)!;
    const source = rays.params.sourceLayerId as string;
    const next = ok(setFxLayerType(added.stored, source, 'shape'));
    expect(layers(next.stored).find((l) => l.id === added.layerId)!.params.sourceLayerId).toBe(next.layerId);
  });
  it('duplicating a scoped effect copies its target', () => {
    const s = scoped();
    const copy = ok(duplicateFxLayer(s.stored, s.bloom));
    expect(targetOf(copy.stored, copy.layerId!)).toBe(s.gradient);
  });
  it('import and preset take their targets from the parsed scene', () => {
    const s = scoped();
    const scene = (s.stored as { scene: unknown }).scene;
    const imported = ok(importFxScene(s.stored, reload(scene)));
    expect(targetOf(imported.stored, s.bloom)).toBe(s.gradient);
    const dangling = reload(scene) as { layers: L[] };
    dangling.layers.find((l) => l.id === s.bloom)!.target = 'nope';
    const bad = ok(importFxScene(s.stored, dangling));
    expect(targetOf(bad.stored, s.bloom)).toBeUndefined();
    expect(bad.notes.join(' ')).toMatch(/whole scene/);
    // a preset replaces the scene: no target survives from the old one
    expect(layers(ok(applyFxPreset(s.stored, 'gold-noise-gradient')).stored).some((l) => l.target)).toBe(false);
  });
});

describe('god rays never read a scoped layer', () => {
  it('a new god rays picks the first untargeted content layer', () => {
    const s = scoped();
    const added = ok(addFxLayer(s.stored, 'godRays'));
    expect(layers(added.stored).find((l) => l.id === added.layerId)!.params.sourceLayerId).toBe(s.noise);
    expect(targetOf(added.stored, s.bloom)).toBe(s.gradient);
  });
  it('is refused when every content layer is scoped', () => {
    const s = scoped();
    const all = ok(setFxLayerTarget(s.stored, s.vignette, s.noise)).stored;
    expect(refused(addFxLayer(all, 'godRays'))).toMatch(/effects of their? own|effects of its own/);
    expect(refused(setFxLayerType(all, s.grain, 'godRays'))).toMatch(/effects of its own/);
  });
  it('setting the source to a scoped layer is refused; to an untargeted one is stored', () => {
    const s = scoped();
    const added = ok(addFxLayer(s.stored, 'godRays'));
    expect(refused(setFxParam(added.stored, added.layerId!, 'sourceLayerId', s.gradient))).toMatch(/has effects of its own/);
    expect(ok(setFxParam(added.stored, added.layerId!, 'sourceLayerId', s.noise)).ok).toBe(true);
  });
  it('removing the source moves god rays to an untargeted layer, or is refused when all others are scoped', () => {
    const s = scoped();
    const added = ok(addFxLayer(s.stored, 'godRays'));
    // source is noise; the other content layer (gradient) is scoped: refused
    expect(refused(removeFxLayer(added.stored, s.noise))).toMatch(/every other layer/);
    // unscope bloom, then removal moves the rays to the gradient
    const free = ok(setFxLayerTarget(added.stored, s.bloom, null)).stored;
    const removed = ok(removeFxLayer(free, s.noise));
    expect(layers(removed.stored).find((l) => l.id === added.layerId)!.params.sourceLayerId).toBe(s.gradient);
  });
});

describe('moves stay among siblings', () => {
  it('a scoped effect moves only among the effects of its layer, a scene-wide effect only among scene-wide ones', () => {
    const s = scoped();
    const addedPix = ok(addFxLayer(s.stored, 'pixelate'));
    const pix = addedPix.layerId!;
    const two = ok(setFxLayerTarget(addedPix.stored, pix, s.gradient)).stored;
    // bloom and pixelate share the gradient: pixelate is the front sibling, bloom the back one
    expect(refused(stepFxLayer(two, pix, 1))).toMatch(/already at the front/);
    expect(ok(stepFxLayer(two, pix, -1)).ok).toBe(true);
    // vignette (scene-wide) cannot move behind grain's group edge into the scoped ones
    const wide = layers(two).filter((l) => ['vignette', 'grain'].includes(l.type));
    expect(refused(stepFxLayer(two, wide[0].id, -1))).toMatch(/already at the back/);
  });
});

describe('setFxLayerInteractivity', () => {
  it('stores pointer settings through the reader and clamps every amount to 0..1', () => {
    const s = scoped();
    const next = ok(setFxLayerInteractivity(s.stored, s.noise, { trackMouse: 5, momentum: -2, spring: 0.5, axes: 'x' }));
    expect(layers(next.stored).find((l) => l.id === s.noise)!.interactivity).toEqual({ trackMouse: 1, momentum: 0, spring: 0.5, axes: 'x' });
  });
  it('starts from the engine default (still) and keeps what is not changed', () => {
    const s = scoped();
    const first = ok(setFxLayerInteractivity(ok(setFxLayerInteractivity(s.stored, s.noise, null)).stored, s.noise, { spring: 0.4 }));
    expect(layers(first.stored).find((l) => l.id === s.noise)!.interactivity).toEqual({ trackMouse: 0, momentum: 0, spring: 0.4, axes: 'both' });
    const second = ok(setFxLayerInteractivity(first.stored, s.noise, { trackMouse: 0.2 }));
    expect(layers(second.stored).find((l) => l.id === s.noise)!.interactivity).toEqual({ trackMouse: 0.2, momentum: 0, spring: 0.4, axes: 'both' });
  });
  it('null removes them; refuses a layer that ignores the pointer, NaN and a bad axis', () => {
    const s = scoped();
    const removed = ok(setFxLayerInteractivity(s.stored, s.noise, null));
    expect('interactivity' in layers(removed.stored).find((l) => l.id === s.noise)!).toBe(false);
    expect(refused(setFxLayerInteractivity(s.stored, s.bloom, { spring: 1 }))).toMatch(/does not react to the pointer/);
    expect(refused(setFxLayerInteractivity(s.stored, s.noise, { spring: NaN }))).toMatch(/must be a number/);
    expect(refused(setFxLayerInteractivity(s.stored, s.noise, { axes: 'z' as never }))).toMatch(/axes/);
    expect(refused(setFxLayerInteractivity(s.stored, 'nope', { spring: 1 }))).toMatch(/no longer in the scene/);
  });
  it('survives a reload and the strict reader unchanged', () => {
    const s = scoped();
    const next = ok(setFxLayerInteractivity(s.stored, s.gradient, { trackMouse: 0.7, axes: 'y' }));
    const read = parseFxProp(reload(next.stored));
    expect(read.ok && read.notes).toEqual([]);
  });
});
