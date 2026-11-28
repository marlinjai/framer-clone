// src/lib/books/__tests__/catalogueGroups.test.ts
//
// The invoice picker's headings (src/lib/books/catalogueGroups.ts).

import { describe, expect, it } from 'vitest';

import { catalogueSiteGroups } from '../catalogueGroups';

const sites = [
  { id: 'a', name: 'Bakery' },
  { id: 'b', name: 'Catering' },
];
const it_ = (id: string, siteId: string | null) => ({ id, siteId });

describe('catalogueSiteGroups', () => {
  it('groups by site in the order of the sites, keeps the order within a group, and the items without a site come last', () => {
    const groups = catalogueSiteGroups([it_('1', 'b'), it_('2', null), it_('3', 'a'), it_('4', 'b')], sites, true);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Bakery', ['3']],
      ['Catering', ['1', '4']],
      ['Company items', ['2']],
    ]);
  });
  it('a site no longer listed keeps its items, after the listed sites and before the items without one', () => {
    const groups = catalogueSiteGroups([it_('1', null), it_('2', 'gone'), it_('3', 'a')], sites, false);
    expect(groups.map((g) => g.label)).toEqual(['Bakery', 'A site no longer listed', 'All sites']);
  });
  it('the items without a site are shared by all sites before the assignment', () => {
    expect(catalogueSiteGroups([it_('1', null)], sites, false).map((g) => g.label)).toEqual(['All sites']);
    expect(catalogueSiteGroups([], sites, true)).toEqual([]);
  });
});
