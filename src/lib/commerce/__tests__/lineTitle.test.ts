// What a bought item is called in the cart and on the receipt (src/lib/commerce/lineTitle.ts).
import { describe, expect, it } from 'vitest';
import { lineTitle } from '@/lib/commerce/lineTitle';

describe('lineTitle', () => {
  it('names the product and its variant', () => {
    expect(lineTitle('Stacking ring', '54 / Silver', 'RING-54-S', 'Item')).toBe('Stacking ring, 54 / Silver');
  });

  it('names the product alone when its variant has no title of its own', () => {
    expect(lineTitle('Ring sizing', null, null, 'Item')).toBe('Ring sizing');
    expect(lineTitle('Ring sizing', '  ', undefined, 'Item')).toBe('Ring sizing');
    expect(lineTitle('Ring sizing', 'Ring sizing', undefined, 'Item')).toBe('Ring sizing');
  });

  it('without the product: the variant, then the SKU, then the fallback word, never an id', () => {
    expect(lineTitle(null, '54 / Silver', 'RING-54-S', 'Artikel')).toBe('54 / Silver');
    expect(lineTitle(undefined, null, 'RING-54-S', 'Artikel')).toBe('RING-54-S');
    expect(lineTitle(null, null, ' ', 'Artikel')).toBe('Artikel');
  });
});
