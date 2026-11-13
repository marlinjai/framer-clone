// @vitest-environment node
// The text box layer (kind `textBox`) where the generator and an agent meet it: the
// document they are taught says it is decorative only, a stored scene holding one comes
// through the real reader unchanged, and the panel's own edits (add, set) reach it.

import { describe, expect, it } from 'vitest';
import { serializeScene } from '@/lib/fx/format';
import { addFxLayer, fxFromPreset, setFxParam } from '../edit';
import { parseFxProp } from '../fxScene';
import { fxGenerationDocs, readGeneratedFx } from '../generation';

function base() {
  const made = fxFromPreset('noise-gradient');
  if (!made.ok) throw new Error(made.message);
  return made.stored;
}

describe('the text box in what the generator is taught', () => {
  it('says the text box is decorative only and never the page\'s real text', () => {
    const docs = fxGenerationDocs();
    expect(docs).toContain('"textBox" layer');
    expect(docs).toMatch(/decorative only/);
    expect(docs).toMatch(/never\s+the page's headline/);
  });
});

describe('a stored scene with a text box, through the generator\'s reader', () => {
  it('is kept as written, with nothing noted', () => {
    const added = addFxLayer(base(), 'textBox');
    if (!added.ok || !added.layerId) throw new Error('could not add the layer');
    const set = setFxParam(added.stored, added.layerId, 'text', 'Hello\nthere');
    if (!set.ok) throw new Error(set.message);

    const outcome = readGeneratedFx(JSON.parse(JSON.stringify(set.stored)));
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.notes).toEqual([]);
    const read = parseFxProp(outcome.stored);
    if (!read.ok) throw new Error(read.message);
    const layer = read.fx.scene.layers.find((l) => l.id === added.layerId)!;
    expect(layer.type).toBe('textBox');
    expect(layer.params.text.value).toBe('Hello\nthere');
    const direct = parseFxProp(set.stored);
    if (!direct.ok) throw new Error(direct.message);
    expect(JSON.stringify(serializeScene(read.fx.scene))).toBe(JSON.stringify(serializeScene(direct.fx.scene)));
  });

  it('a value out of range is moved into it with a note, as for every other layer', () => {
    const added = addFxLayer(base(), 'textBox');
    if (!added.ok || !added.layerId) throw new Error('could not add the layer');
    const stored = JSON.parse(JSON.stringify(added.stored));
    const layer = stored.scene.layers.find((l: { id: string }) => l.id === added.layerId);
    layer.params.size = 9;
    const outcome = readGeneratedFx(stored);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.notes.length).toBeGreaterThan(0);
    const read = parseFxProp(outcome.stored);
    if (!read.ok) throw new Error(read.message);
    expect(read.fx.scene.layers.find((l) => l.id === added.layerId)!.params.size.value).toBe(0.5);
  });
});

describe('the panel\'s edits on a text box (one change, strict reader)', () => {
  it('adds it with its defaults and sets a setting; a bad value is clamped with a note', () => {
    const added = addFxLayer(base(), 'textBox');
    if (!added.ok || !added.layerId) throw new Error('could not add the layer');
    const moved = setFxParam(added.stored, added.layerId, 'position', [3, -3]);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.notes.length).toBeGreaterThan(0);
    expect(moved.fx.scene.layers.find((l) => l.id === added.layerId)!.params.position.value).toEqual([1, 0]);
  });
});
