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
import { buildSchemaDocs } from '../schemaDocs';
import { BANNED_FONT_FAMILIES, FONT_LIBRARY, fontStack } from '@/lib/fonts/registry';
import { deriveBreakpointKeys, listGenerationTags } from '../schema';

describe('buildSchemaDocs', () => {
  const docs = buildSchemaDocs();

  it('matches the golden file', async () => {
    await expect(docs).toMatchFileSnapshot('./__golden__/schemaDocs.md');
  });

  it('documents every registry entry with its type and defaults', () => {
    for (const entry of Object.values(COMPONENT_REGISTRY)) {
      expect(docs).toContain(`### preset "${entry.id}" (${entry.label}, category ${entry.category})`);
      expect(docs).toContain(`- type: ${entry.htmlType}`);
      expect(docs).toContain(`- defaults: ${stableStringify(entry.defaultProps)}`);
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
