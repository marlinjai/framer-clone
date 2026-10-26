// src/lib/books/__tests__/products.test.ts
//
// The fold the catalogue searches with, and the line fields a catalogue item
// gives (catalogue design, "The Books' own list is replaced"). Headless.

import { describe, expect, it } from 'vitest';

import type { CatalogueItemView } from '../api';
import { lineFromProduct } from '../products';
import { foldKey, searchWords } from '../searchKey';

describe('foldKey', () => {
  it('ignores case, accents, compatibility forms and repeated spaces; writes ß as ss', () => {
    expect(foldKey('  Beratúng   vor  Ort ')).toBe('beratung vor ort');
    expect(foldKey('ÄÖÜ äöü')).toBe('aou aou');
    expect(foldKey('Straße')).toBe(foldKey('STRASSE'));
    expect(foldKey('ẞ')).toBe('ss');
    expect(foldKey('ﬁle')).toBe('file');
    expect(foldKey('Crème brûlée')).toBe('creme brulee');
    expect(foldKey('́')).toBe('');
  });

  it('splits a search into folded words', () => {
    expect(searchWords('  BERATUNG  Ört ')).toEqual(['beratung', 'ort']);
    expect(searchWords('   ')).toEqual([]);
  });
});

const item: CatalogueItemView = {
  variantId: 'v1',
  productId: 'p1',
  kind: 'product',
  title: 'Ring (Gold)',
  description: 'Handgeschmiedet',
  unitLabel: 'Stk',
  unitPrice: 12500,
  priceBasis: 'gross',
  taxClass: 'reduced',
  discountBp: 500,
  status: 'draft',
};

describe('lineFromProduct', () => {
  it('copies the item into exactly the fields of a line, with the basis of its price and the variant as reference', () => {
    expect(lineFromProduct(item)).toEqual({
      kind: 'product',
      title: 'Ring (Gold)',
      description: 'Handgeschmiedet',
      unitLabel: 'Stk',
      unitPrice: 12500,
      priceBasis: 'gross',
      taxClass: 'reduced',
      discountBp: 500,
      variantRef: 'v1',
    });
  });

  it('gives no description for a blank one, keeps a missing tax class missing, and never carries the product id', () => {
    const line = lineFromProduct({ ...item, description: '   ', taxClass: null });
    expect(line.description).toBeNull();
    expect(line.taxClass).toBeNull();
    expect(Object.keys(line)).not.toContain('productId');
    expect(JSON.stringify(lineFromProduct(item))).not.toContain('p1');
  });

  it('is a copy: changing the item afterwards leaves the fields as they were', () => {
    const p = { ...item };
    const line = lineFromProduct(p);
    p.title = 'Renamed';
    p.unitPrice = 1;
    expect(line.title).toBe('Ring (Gold)');
    expect(line.unitPrice).toBe(12500);
  });
});
