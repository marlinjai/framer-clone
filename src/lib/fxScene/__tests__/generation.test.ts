// @vitest-environment node
// What the generator and an agent may write for an FX scene (../generation): the preset
// form and the stored form, every way either can be wrong, and the text both are taught.

import { describe, expect, it } from 'vitest';
import { FX_LIMITS, PRESETS, serializeScene } from '@/lib/fx/format';
import { FX_DEFAULT_PRESET, addFxLayer, fxFromPreset, setFxParam } from '../edit';
import { parseFxProp } from '../fxScene';
import { fxGenerationDocs, readGeneratedFx, type GeneratedFx } from '../generation';

const SITE_IMAGE = `/site-images/${'a'.repeat(64)}.png`;

function ok(result: GeneratedFx): Extract<GeneratedFx, { ok: true }> {
  if (!result.ok) throw new Error(`expected a scene, got: ${result.message}`);
  return result;
}
const sceneOf = (result: GeneratedFx) => {
  const read = parseFxProp(ok(result).stored);
  if (!read.ok) throw new Error(read.message);
  return read.fx;
};
const preset = (id: string) => {
  const made = fxFromPreset(id);
  if (!made.ok) throw new Error(made.message);
  return made;
};
const layerOf = (result: GeneratedFx, id: string) => sceneOf(result).scene.layers.find((l) => l.id === id)!;

describe('the preset form', () => {
  it('nothing written is the default preset, with its box background and nothing to say', () => {
    const made = ok(readGeneratedFx(undefined));
    expect(made.notes).toEqual([]);
    expect(JSON.stringify(made.stored)).toBe(JSON.stringify(preset(FX_DEFAULT_PRESET).stored));
    expect(made.background).toBe(preset(FX_DEFAULT_PRESET).background);
  });

  it.each(PRESETS.filter((p) => !p.load().layers.some((l) => l.type === 'text')).map((p) => p.id))('a preset without text is exactly that preset: %s', (id) => {
    const made = ok(readGeneratedFx({ preset: id }));
    expect(made.notes).toEqual([]);
    expect(JSON.stringify(serializeScene(sceneOf(made).scene))).toBe(JSON.stringify(serializeScene(preset(id).fx.scene)));
  });

  it('retunes and recolours inside the ranges, and changes nothing else', () => {
    const made = ok(
      readGeneratedFx({
        preset: 'gold-noise-gradient',
        start: 'visible',
        calm: 'frame',
        background: '#101820',
        layers: [
          { id: 'gradient-bg', params: { colorA: '#112233', speed: 0.5 } },
          { id: 'grain', visible: false },
        ],
      }),
    );
    expect(made.notes).toEqual([]);
    const fx = sceneOf(made);
    expect([fx.start, fx.calm, fx.scene.background]).toEqual(['visible', 'frame', '#101820']);
    expect(layerOf(made, 'gradient-bg').params.colorA.value).toBe('#112233');
    expect(layerOf(made, 'gradient-bg').params.speed.value).toBe(0.5);
    expect(layerOf(made, 'grain').visible).toBe(false);
    // Every other setting is the preset's.
    const before = preset('gold-noise-gradient').fx.scene.layers;
    for (const layer of fx.scene.layers) {
      const was = before.find((l) => l.id === layer.id)!;
      for (const [key, schema] of Object.entries(layer.params)) {
        if (layer.id === 'gradient-bg' && (key === 'colorA' || key === 'speed')) continue;
        expect(schema.value, `${layer.id}.${key}`).toEqual(was.params[key].value);
      }
    }
    expect(fx.scene.layers.map((l) => l.id)).toEqual(before.map((l) => l.id));
  });

  it('refuses a preset that does not exist, naming the ones that do', () => {
    const made = readGeneratedFx({ preset: 'sparkles' });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.message).toMatch(/no FX preset called "sparkles".*"gold-noise-gradient"/);
  });

  it('refuses what is not an object and what names no preset', () => {
    for (const value of ['gold-noise-gradient', 7, [], { layers: [] }, { preset: 3 }]) expect(readGeneratedFx(value).ok, JSON.stringify(value)).toBe(false);
  });

  it('leaves out an invented layer, by id or by kind, and says so', () => {
    const made = ok(
      readGeneratedFx({
        preset: 'gold-noise-gradient',
        layers: [
          { id: 'sparkles', type: 'particleStorm', params: { count: 9000 } },
          { id: 'bloom', type: 'godRays' },
          { type: 'gradient' },
        ],
      }),
    );
    expect(made.notes).toHaveLength(3);
    expect(made.notes[0]).toMatch(/"sparkles" of the kind "particleStorm" is not a layer of the preset.*cannot gain one/);
    expect(made.notes[1]).toMatch(/"bloom" of the kind "godRays" is not a layer of the preset/);
    expect(made.notes[2]).toMatch(/without an "id"/);
    // The scene is the preset, untouched.
    expect(JSON.stringify(serializeScene(sceneOf(made).scene))).toBe(JSON.stringify(serializeScene(preset('gold-noise-gradient').fx.scene)));
  });

  it('says what it did with a setting that does not exist, the wrong kind of value, a value out of range and a colour that is none', () => {
    const made = ok(
      readGeneratedFx({
        preset: 'gold-noise-gradient',
        layers: [{ id: 'bloom', params: { sparkle: 2, intensity: 'very', radius: 9999 } }, { id: 'noise', params: { color: 'goldish' } }],
      }),
    );
    const text = made.notes.join('\n');
    expect(text).toMatch(/Layer "bloom" has no setting called "sparkle"/);
    expect(text).toMatch(/intensity/);
    expect(text).toMatch(/9999 is outside/);
    expect(text).toMatch(/color/i);
    const before = preset('gold-noise-gradient').fx.scene.layers;
    expect(layerOf(made, 'bloom').params.intensity.value).toBe(before.find((l) => l.id === 'bloom')!.params.intensity.value);
    const radius = layerOf(made, 'bloom').params.radius;
    expect(radius.type === 'number' && radius.value).toBe(radius.type === 'number' ? radius.max : NaN);
    expect(layerOf(made, 'noise').params.color.value).toBe(before.find((l) => l.id === 'noise')!.params.color.value);
  });

  it('says so for a start, a calm state, a background, a layer list and a key that are not what they should be', () => {
    const made = ok(readGeneratedFx({ preset: 'noise-gradient', start: 'soon', calm: 'still', background: 5, layers: 'all', speed: 3 }));
    const text = made.notes.join('\n');
    for (const expected of [/start "soon" is not one of/, /calm "still" is not one of/, /background must be a colour/, /fx\.layers must be a list/, /fx\.speed is not a setting of a scene/]) {
      expect(text).toMatch(expected);
    }
    expect(sceneOf(made).start).toBe('settled');
  });

  it('reads at most as many layer entries as a scene may hold layers', () => {
    const many = Array.from({ length: FX_LIMITS.layers + 5 }, () => ({ id: 'bloom', params: { intensity: 1 } }));
    expect(ok(readGeneratedFx({ preset: 'gold-noise-gradient', layers: many })).notes.join(' ')).toMatch(/Only the first 16 layer entries/);
  });

  it('never takes a picture address: no preset holds an image layer, and the stored form has its own rule', () => {
    for (const p of PRESETS) expect(p.load().layers.some((l) => l.type === 'image'), p.id).toBe(false);
  });
});

describe('a preset that draws text', () => {
  const TEXT_PRESET = 'godrays-hero';

  it('hides a text layer that was given no text, and says how to keep it: the sample words are someone else\'s', () => {
    const made = ok(readGeneratedFx({ preset: TEXT_PRESET }));
    expect(layerOf(made, 'text-lockup').visible).toBe(false);
    expect(made.notes).toHaveLength(1);
    expect(made.notes[0]).toMatch(/"text-lockup".*draws text.*was hidden.*headlineText.*"visible": false/);
  });

  it('given its text, shows exactly that: what was not given is empty, never the sample', () => {
    const made = ok(readGeneratedFx({ preset: TEXT_PRESET, layers: [{ id: 'text-lockup', params: { headlineText: 'Backhaus Lindner' } }] }));
    expect(made.notes).toEqual([]);
    const layer = layerOf(made, 'text-lockup');
    expect(layer.visible).toBe(true);
    expect([layer.params.eyebrowText.value, layer.params.headlineText.value, layer.params.taglineText.value]).toEqual(['', 'Backhaus Lindner', '']);
    expect(JSON.stringify(ok(made).stored)).not.toMatch(/Lumitra|Introducing/);
  });

  it('hidden on purpose, says nothing', () => {
    const made = ok(readGeneratedFx({ preset: TEXT_PRESET, layers: [{ id: 'text-lockup', visible: false }] }));
    expect(made.notes).toEqual([]);
    expect(layerOf(made, 'text-lockup').visible).toBe(false);
  });

  it('cuts text that is too long, with a note', () => {
    const made = ok(readGeneratedFx({ preset: TEXT_PRESET, layers: [{ id: 'text-lockup', params: { headlineText: 'x'.repeat(FX_LIMITS.text + 50) } }] }));
    expect(String(layerOf(made, 'text-lockup').params.headlineText.value).length).toBeLessThanOrEqual(FX_LIMITS.text);
    expect(made.notes.length).toBeGreaterThan(0);
  });
});

describe('the stored form', () => {
  it('a stored scene comes back exactly, with nothing to say: what a box holds can be sent again', () => {
    const stored = preset('bokeh-focuspull').stored;
    const made = ok(readGeneratedFx(JSON.parse(JSON.stringify(stored))));
    expect(made.notes).toEqual([]);
    expect(made.background).toBeUndefined();
    expect(JSON.stringify(made.stored)).toBe(JSON.stringify(stored));
  });

  it('leaves out a layer of an unknown kind, with a note', () => {
    const stored = JSON.parse(JSON.stringify(preset('gold-noise-gradient').stored));
    stored.scene.layers.push({ id: 'storm', type: 'particleStorm', name: 'Storm', visible: true, blend: 'normal', params: {} });
    const made = ok(readGeneratedFx(stored));
    expect(made.notes.join(' ')).toMatch(/unknown type "particleStorm" and was left out/);
    expect(sceneOf(made).scene.layers.map((l) => l.type)).not.toContain('particleStorm');
  });

  it('accepts a picture this site could store and refuses an address from anywhere else, whole', () => {
    const added = addFxLayer(preset('gold-noise-gradient').stored, 'image');
    if (!added.ok || !added.layerId) throw new Error('no image layer');
    const own = setFxParam(added.stored, added.layerId, 'src', SITE_IMAGE);
    if (!own.ok) throw new Error(own.message);
    expect(ok(readGeneratedFx(JSON.parse(JSON.stringify(own.stored)))).notes).toEqual([]);

    for (const src of ['https://evil.test/a.png', '/api/projects/x/images/abc', 'javascript:alert(1)', '//evil.test/a.png']) {
      const foreign = JSON.parse(JSON.stringify(own.stored));
      foreign.scene.layers.find((l: { type: string }) => l.type === 'image').params.src = src;
      const made = readGeneratedFx(foreign);
      expect(made.ok, src).toBe(false);
      if (!made.ok) expect(made.message).toMatch(/image address that is not allowed here/);
    }
  });

  it('refuses a version it does not know and a scene that is none', () => {
    expect(readGeneratedFx({ version: 99, scene: {} }).ok).toBe(false);
    expect(readGeneratedFx({ scene: 'big' }).ok).toBe(false);
  });
});

describe('what the generator and an agent are told', () => {
  const docs = fxGenerationDocs();

  it('names every preset with every layer and every setting it can change, and no picture address', () => {
    for (const p of PRESETS) {
      expect(docs).toContain(`### FX preset "${p.id}"`);
      for (const layer of preset(p.id).fx.scene.layers) {
        expect(docs).toContain(`- "${layer.id}" (${layer.type}`);
        // All but a text layer's fonts: the engine's own list holds typefaces the generator is told not to use.
        for (const key of Object.keys(layer.params).filter((k) => !/Font$/.test(k))) expect(docs, `${p.id} ${layer.id}.${key}`).toContain(`${key} `);
      }
    }
    expect(docs).not.toMatch(/\bsrc\b/);
    expect(docs).not.toMatch(/eyebrowFont|bodyFont/);
  });

  it('is the same text on every run (it sits in a cached prompt prefix)', () => {
    expect(fxGenerationDocs()).toBe(docs);
  });

  it('every documented example is accepted as written: each setting at both ends of its range', () => {
    for (const p of PRESETS) {
      const layers = preset(p.id).fx.scene.layers.map((layer) => {
        const params: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(layer.params)) {
          if (schema.type === 'number') params[key] = schema.max;
          else if (schema.type === 'select' && key !== 'sourceLayerId') params[key] = schema.options[schema.options.length - 1];
          else if (schema.type === 'string') params[key] = 'Text';
        }
        return { id: layer.id, params };
      });
      expect(ok(readGeneratedFx({ preset: p.id, layers })).notes, p.id).toEqual([]);
    }
  });

  it('stays a modest part of the prompt', () => {
    expect(docs.length).toBeLessThan(12_000);
  });
});
