import { describe, expect, it } from 'vitest';
import pageItems from '../data/page-items.json';
import { LINK_RELS, META_NAMES, PROPERTY_NAMES, PROPERTY_PREFIXES, parseHeadItem } from '@/lib/site/headItems';
import { headSample } from './headRows';

describe('the head rows of the score', () => {
  it('are exactly the closed lists of headItems.ts: 17 meta names, 8 properties, 7 rels, JSON-LD', () => {
    const expected = [
      ...[...META_NAMES].map((n) => `meta:${n}`),
      ...PROPERTY_PREFIXES.map((p) => `property:${p}*`),
      ...[...PROPERTY_NAMES].map((n) => `property:${n}`),
      ...LINK_RELS.map((r) => `link:${r}`),
      'jsonld',
    ];
    expect([...pageItems.head].sort()).toEqual([...expected].sort());
    expect(pageItems.head).toHaveLength(33);
  });

  it('each stands for an item the parser accepts', () => {
    for (const id of pageItems.head) expect(parseHeadItem(headSample(id)).ok, id).toBe(true);
  });
});
