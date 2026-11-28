// src/lib/catalog/__tests__/siteRule.test.ts
//
// Which product may join which collection by their catalogues (src/lib/catalog/siteRule.ts).

import { describe, expect, it } from 'vitest';

import { sameCatalogue } from '../siteRule';

describe('sameCatalogue', () => {
  it('the same site, or both without one, always', () => {
    for (const assigned of [false, true]) {
      expect(sameCatalogue('a', 'a', assigned)).toBe(true);
      expect(sameCatalogue(null, null, assigned)).toBe(true);
    }
  });
  it('two different sites, never', () => {
    expect(sameCatalogue('a', 'b', false)).toBe(false);
    expect(sameCatalogue('a', 'b', true)).toBe(false);
  });
  it('one without a site: only while the company is not assigned', () => {
    expect(sameCatalogue(null, 'a', false)).toBe(true);
    expect(sameCatalogue('a', null, false)).toBe(true);
    expect(sameCatalogue(null, 'a', true)).toBe(false);
    expect(sameCatalogue('a', null, true)).toBe(false);
  });
});
