// The head item rows of the primitive score (docs/plans/2026-11-02-theme-and-head.md, Score
// changes): one stored item standing for each row, and the row ids the score reads from
// test/score/data/page-items.json. Pure, so a unit test holds the two lists to the closed lists
// of src/lib/site/headItems.ts: a name added there without a row fails here.

import type { StoredHeadItem } from '@/lib/site/headItems';

const FAR = 'https://example.org';

/** The stored item that stands for a row, by the part of the id after `head:`. */
export function headSample(id: string): StoredHeadItem {
  const [kind, ...rest] = id.split(':');
  const name = rest.join(':');
  switch (kind) {
    case 'meta':
      return { kind: 'meta', name, content: `value of ${name}` };
    case 'property': {
      const sample: Record<string, string> = {
        'article:*': 'article:tag',
        'product:*': 'product:price:amount',
        'profile:*': 'profile:first_name',
        'book:*': 'book:isbn',
      };
      return { kind: 'property', property: sample[name] ?? name, content: `value of ${name}` };
    }
    case 'link':
      return name === 'alternate'
        ? { kind: 'link', rel: 'alternate', href: `${FAR}/de`, hreflang: 'de' }
        : { kind: 'link', rel: name, href: `${FAR}/${name}` };
    case 'jsonld':
      return { kind: 'jsonld', data: { '@context': 'https://schema.org', '@type': 'Organization', name: 'Bakery', url: `${FAR}/` } };
    default:
      throw new Error(`no sample for head row ${id}`);
  }
}
