// Golden test: the model-facing schema docs are generated from the real
// component registry, the properties panel's tag sets and CSS_PROP_SET. If any
// of those change, this test fails until the golden file is regenerated
// (`pnpm vitest run -u src/lib/ai/pageGen`) and the diff is reviewed: the diff
// IS what the model will be told differently.

import { describe, expect, it } from 'vitest';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { CSS_PROP_SET } from '@/models/ComponentModel';
import { CONTAINER_TYPES, TEXT_TYPES } from '@/components/sidebars/right/sectionConfig';
import { stableStringify } from '@/lib/ai/serializers/normalize';
import { HOVER_GATE } from '@/lib/rules/states';
import { TAUGHT_RULE_ROWS, rulesDocs } from '../promptSections/rules';
import { buildSchemaDocs } from '../schemaDocs';
import { BANNED_FONT_FAMILIES, FONT_LIBRARY, fontStack } from '@/lib/fonts/registry';
import { deriveBreakpointKeys, listGenerationTags } from '../schema';

describe('buildSchemaDocs', () => {
  const docs = buildSchemaDocs();

  it('matches the golden file', async () => {
    await expect(docs).toMatchFileSnapshot('./__golden__/schemaDocs.md');
  });

  it('tells the model to put the add to cart and a variant price inside the variant selector', () => {
    const selectorLine = docs.split('\n').find((line) => line.startsWith('- shop control "variant-selector"'))!;
    expect(selectorLine).toContain('Put the add to cart and any price bound to the variant');
    expect(selectorLine).toContain('INSIDE it');
    expect(selectorLine).not.toContain('never add children');
    const addToCartLine = docs.split('\n').find((line) => line.startsWith('- shop control "add-to-cart"'))!;
    expect(addToCartLine).toContain('put it INSIDE the variant selector');
  });

  it('teaches the short list of rules and nothing else', () => {
    const section = rulesDocs();
    expect(docs).toContain(section);
    for (const form of ['&:hover', HOVER_GATE, '&:active', '&:focus-visible', '&::before', '&::after', ':nth-child(2n)', 'prefers-color-scheme']) {
      expect(section).toContain(form);
    }
    expect(TAUGHT_RULE_ROWS.size).toBe(7);
    for (const untaught of ['@keyframes', '@font-face', '@container', '@supports', ':has', ':is(', 'animation', '"define"']) {
      expect(section).not.toContain(untaught);
    }
  });

  it('documents every registry entry with its type and defaults', () => {
    for (const entry of Object.values(COMPONENT_REGISTRY).filter((at) => !at.preset && at.generation !== false)) {
      expect(docs).toContain(`### preset "${entry.id}" (${entry.label}, category ${entry.category})`);
      expect(docs).toContain(`- type: ${entry.htmlType}`);
      // An FX scene box is documented without its stored scene (validateFxScene.test.ts).
      const { fx: _scene, ...defaults } = entry.defaultProps as Record<string, unknown>;
      void _scene;
      expect(docs).toContain(`- defaults: ${stableStringify(entry.id === 'fxScene' ? defaults : entry.defaultProps)}`);
    }
  });

  it('holds no entry back: every entry has a checked way to be written', () => {
    expect(Object.values(COMPONENT_REGISTRY).filter((at) => at.generation === false)).toEqual([]);
  });

  it('teaches no behaviour preset as an element, which is all its entry names', () => {
    for (const entry of Object.values(COMPONENT_REGISTRY).filter((at) => at.preset)) {
      expect(docs).not.toContain(`### preset "${entry.id}"`);
    }
  });

  it('lists every CSS property the editor supports and nothing else', () => {
    const line = docs.split('\n').at(-1) ?? '';
    expect(line.split(', ').sort()).toEqual([...CSS_PROP_SET].sort());
  });

  it('offers every tag the properties panel can edit plus the registry tags', () => {
    const tags = listGenerationTags();
    for (const t of [...CONTAINER_TYPES, ...TEXT_TYPES]) expect(tags).toContain(t);
    for (const e of Object.values(COMPONENT_REGISTRY)) expect(tags).toContain(e.htmlType);
    for (const t of tags) expect(docs).toContain(`- ${t}: `);
  });

  it('lists every library font by its exact stack, and no banned typeface', () => {
    for (const f of FONT_LIBRARY) expect(docs).toContain(`"${fontStack(f)}"`);
    for (const banned of BANNED_FONT_FAMILIES) expect(docs).not.toContain(banned);
  });

  it('is deterministic (prompt-cache stable)', () => {
    expect(buildSchemaDocs()).toBe(docs);
  });

  it('contains no long dashes', () => {
    expect(docs).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('deriveBreakpointKeys', () => {
  it('slugs labels, largest first, and keeps keys unique', () => {
    expect(
      deriveBreakpointKeys([
        { label: 'Mobile', minWidth: 320 },
        { label: 'Desktop', minWidth: 1280 },
        { label: 'Tablet', minWidth: 768 },
      ]).map((b) => b.key),
    ).toEqual(['desktop', 'tablet', 'mobile']);
    expect(
      deriveBreakpointKeys([
        { label: 'Wide', minWidth: 1600 },
        { label: 'wide', minWidth: 1280 },
        { label: '', minWidth: 500 },
        { label: 'Base', minWidth: 300 },
      ]).map((b) => b.key),
    ).toEqual(['wide', 'wide-2', 'bp-500', 'bp-300']);
  });
});
