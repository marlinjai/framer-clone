// src/lib/books/__tests__/products.test.ts
//
// The fold the product list compares names and searches with, and the line
// fields an item gives (invoice editor plan, phase 4). Headless.

import { describe, expect, it } from 'vitest';

import type { ProductView } from '../api';
import { lineFromProduct, productNameProblem } from '../products';
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

const product: ProductView = {
  id: 'p1',
  kind: 'product',
  name: 'Druck A4',
  description: 'Farbig, beidseitig',
  unitLabel: 'Stk',
  unitPrice: 1250,
  priceBasis: 'gross',
  taxClass: 'reduced',
  discountBp: 500,
  archivedAt: null,
  createdAt: '2026-10-23T08:00:00.000Z',
  updatedAt: '2026-10-23T08:00:00.000Z',
};

describe('productNameProblem', () => {
  it('is the one name rule of the form and the server', () => {
    expect(productNameProblem('Beratung')).toBeNull();
    expect(productNameProblem('')).toBe('Enter a name.');
    expect(productNameProblem('-')).toMatch(/letter or digit/);
    expect(productNameProblem('!!!')).toMatch(/letter or digit/);
    expect(productNameProblem('x'.repeat(301))).toMatch(/300/);
    // U+FDFA folds to 18 letters: 300 of them fit the 300 characters but not the stored fold.
    expect(productNameProblem('ﷺ'.repeat(300))).toMatch(/too long/);
    expect(productNameProblem('ﷺ'.repeat(10))).toBeNull();
  });
});

describe('lineFromProduct', () => {
  it('copies the item into exactly the fields of a line, with the basis of its price', () => {
    expect(lineFromProduct(product)).toEqual({
      kind: 'product',
      title: 'Druck A4',
      description: 'Farbig, beidseitig',
      unitLabel: 'Stk',
      unitPrice: 1250,
      priceBasis: 'gross',
      taxClass: 'reduced',
      discountBp: 500,
    });
  });

  it('gives no description for a blank one, and never carries the item id', () => {
    const line = lineFromProduct({ ...product, description: '   ' });
    expect(line.description).toBeNull();
    expect(Object.keys(line)).not.toContain('id');
    expect(JSON.stringify(lineFromProduct(product))).not.toContain('p1');
  });

  it('is a copy: changing the item afterwards leaves the fields as they were', () => {
    const p = { ...product };
    const line = lineFromProduct(p);
    p.name = 'Renamed';
    p.unitPrice = 1;
    expect(line.title).toBe('Druck A4');
    expect(line.unitPrice).toBe(1250);
  });
});
