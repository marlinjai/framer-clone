// @vitest-environment node
// Setting groups are presentation only (SETTING_GROUPS in src/lib/fx/schemas.ts): they must not
// change what any preset serializes to, nor what the generator is told about the layer schemas
// (`fxGenerationDocs`). The golden file was taken from origin/main (84bff0b3, before groups
// existed) with every preset, gold-noise-gradient included. A change to either is a change to
// the stored format or the generator's contract, and is made on purpose or not at all.

import { describe, expect, it } from 'vitest';
import { PRESETS, serializeScene, listAddableTypes, settingGroupOf } from '@/lib/fx/format';
import { fxGenerationDocs } from '../generation';
import golden from './fixtures/settingGroups.golden.json';

describe('setting groups change nothing that is stored or generated', () => {
  it.each(PRESETS.map((p) => p.id))('preset %s serializes exactly as before groups existed', (id) => {
    const preset = PRESETS.find((p) => p.id === id)!;
    expect(JSON.parse(JSON.stringify(serializeScene(preset.load())))).toEqual((golden.presets as Record<string, unknown>)[id]);
  });

  it('every preset in the golden file is still a preset, and the gold preset is among them', () => {
    expect(Object.keys(golden.presets).sort()).toEqual(PRESETS.map((p) => p.id).sort());
    expect(Object.keys(golden.presets)).toContain('gold-noise-gradient');
  });

  it('the generator\'s schema documents are unchanged', () => {
    expect(fxGenerationDocs()).toBe(golden.docs);
  });

  it('a group never reaches a serialized layer, and only names existing settings', async () => {
    const { SETTING_GROUPS } = await import('@/lib/fx/schemas');
    const { getLayerSchema } = await import('@/lib/fx/format');
    for (const [type, groups] of Object.entries(SETTING_GROUPS)) {
      const schema = getLayerSchema(type);
      expect(schema, type).toBeTruthy();
      for (const key of Object.keys(groups)) expect(Object.keys(schema!.defaultParams), `${type}.${key}`).toContain(key);
      for (const key of Object.keys(schema!.defaultParams)) expect(JSON.stringify(schema!.defaultParams[key])).not.toMatch(/"group"/);
    }
    expect(settingGroupOf('noiseFill', 'color')).toBeNull();
    expect(settingGroupOf('text', 'headlineText')).toBe('Text');
    expect(listAddableTypes().length).toBeGreaterThan(0);
  });
});
