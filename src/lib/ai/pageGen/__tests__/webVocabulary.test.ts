// The accepted lists are generated, so they cannot be edited into disagreeing with
// the data the primitive score reads, and they are data only: what is refused on
// top stays refused whatever the data adds.

import { describe, expect, it } from 'vitest';
import { buildWebVocabulary, renderWebVocabulary } from '../../../../../test/score/lib/vocabulary';
import { WEB_ATTRIBUTE_PROP_NAMES, WEB_ELEMENT_ATTRIBUTES, WEB_GLOBAL_ATTRIBUTES, WEB_STYLE_KEYS, WEB_TAGS } from '../webVocabulary';
import { FORBIDDEN_TAGS, acceptedTag, isAcceptedAttribute, isAcceptedStyleKey, listGenerationStyleKeys, listGenerationTags } from '../schema';
import { BLOCKED_TAGS } from '@/lib/renderer/blockedNodes';

describe('webVocabulary', () => {
  it('matches the data: run pnpm gen:web-vocabulary when this fails', async () => {
    await expect(renderWebVocabulary(buildWebVocabulary())).toMatchFileSnapshot('../webVocabulary.ts');
  });

  it('holds no handler, whatever the data lists', () => {
    const names = [...WEB_GLOBAL_ATTRIBUTES, ...Object.values(WEB_ELEMENT_ATTRIBUTES).flat(), ...Object.keys(WEB_ATTRIBUTE_PROP_NAMES)];
    for (const name of names.filter((n) => n.startsWith('on'))) {
      for (const tag of WEB_TAGS) expect(isAcceptedAttribute(tag, name)).toBe(false);
    }
  });

  it('accepts what the prompt teaches, and no blocked or forbidden tag', () => {
    for (const tag of listGenerationTags()) expect(acceptedTag(tag, 'html')).toBe(tag);
    for (const key of listGenerationStyleKeys()) expect(isAcceptedStyleKey(key)).toBe(true);
    for (const tag of [...BLOCKED_TAGS, ...FORBIDDEN_TAGS]) {
      expect(acceptedTag(tag, 'html')).toBeUndefined();
      expect(acceptedTag(tag, 'svg')).toBeUndefined();
      expect(acceptedTag(tag, 'mathml')).toBeUndefined();
    }
  });

  it('spells style keys the way a node stores them', () => {
    expect(WEB_STYLE_KEYS).toEqual(expect.arrayContaining(['clipPath', 'scrollSnapType', 'WebkitLineClamp']));
  });
});
