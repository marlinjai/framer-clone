// The accepted lists are generated, so they cannot be edited into disagreeing with
// the data the primitive score reads, and they are data only: what is refused on
// top stays refused whatever the data adds.

import { describe, expect, it } from 'vitest';
import { buildWebVocabulary, renderWebVocabulary } from '../../../../../test/score/lib/vocabulary';
import { WEB_ATTRIBUTE_PROP_NAMES, WEB_ELEMENT_ATTRIBUTES, WEB_GLOBAL_ATTRIBUTES, WEB_MATHML_TAGS, WEB_STYLE_KEYS, WEB_SVG_TAGS, WEB_TAGS } from '../webVocabulary';
import { REFUSED_ATTRIBUTES, REVIEWED_ATTRIBUTES, REVIEWED_HTML_TAGS, REVIEWED_MATHML_TAGS, REVIEWED_SVG_TAGS } from '../reviewedVocabulary';
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

  it('has a decision for every tag: a new one in the data stays out and fails here until someone judges it', () => {
    expect(WEB_TAGS.filter((tag) => !REVIEWED_HTML_TAGS.has(tag) && !FORBIDDEN_TAGS.has(tag))).toEqual([]);
    expect(WEB_SVG_TAGS.filter((tag) => !REVIEWED_SVG_TAGS.has(tag) && !FORBIDDEN_TAGS.has(tag.toLowerCase()))).toEqual([]);
    expect(WEB_MATHML_TAGS.filter((tag) => !REVIEWED_MATHML_TAGS.has(tag))).toEqual([]);
  });

  it('has a decision for every attribute on a tag the generator writes', () => {
    const generated = (tag: string) => acceptedTag(tag, 'html') ?? acceptedTag(tag, 'svg') ?? acceptedTag(tag, 'mathml');
    const reachable = Object.entries(WEB_ELEMENT_ATTRIBUTES).filter(([tag]) => generated(tag)).flatMap(([, names]) => names);
    const css = new Set(listGenerationStyleKeys().map((key) => key.toLowerCase()));
    const undecided = [...new Set([...WEB_GLOBAL_ATTRIBUTES, ...reachable])]
      .filter((name) => !REVIEWED_ATTRIBUTES.has(name) && !REFUSED_ATTRIBUTES.has(name) && !css.has(name) && !name.startsWith('on'));
    expect(undecided).toEqual([]);
  });

  it('never reviews and refuses the same name', () => {
    expect([...REVIEWED_ATTRIBUTES].filter((name) => REFUSED_ATTRIBUTES.has(name))).toEqual([]);
  });

  it('refuses by default: a name the review has not seen is no attribute, whatever the data says', () => {
    expect(isAcceptedAttribute('div', 'brand-new-attribute')).toBe(false);
    expect(isAcceptedAttribute('div', 'data-anything')).toBe(false);
    expect(acceptedTag('brand-new-tag', 'html')).toBeUndefined();
  });

  it('spells style keys the way a node stores them', () => {
    expect(WEB_STYLE_KEYS).toEqual(expect.arrayContaining(['clipPath', 'scrollSnapType', 'WebkitLineClamp']));
  });
});
