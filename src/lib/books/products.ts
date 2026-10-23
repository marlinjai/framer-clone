// src/lib/books/products.ts
//
// From an item of the company's product and service list to the fields of a
// draft line (invoice editor plan, phase 4; the line search of phase 3 calls
// it). A line COPIES these values when an item is picked and keeps no
// reference to the item (migration 015_books_products, guarantee 1): editing or
// archiving the item later never changes the line.
//
// The unit price is handed over in the basis the item is quoted in
// (`priceBasis`). A draft line's unit price is in the DRAFT's basis (net or
// gross, `DocumentView.netOrGross`); converting between the two needs the tax
// rate of the draft's tax case, which only the server computes (plan decision
// 3: figures are the server's). So the caller compares `priceBasis` with the
// draft's basis and never converts here.
//
// Client-safe: no server imports.

import type { ProductView } from './api';

/** The fields of a draft line an item fills: exactly a body of POST .../lines, without quantity and version. */
export interface ProductLineFields {
  kind: 'service' | 'product';
  title: string;
  description: string | null;
  unitLabel: string;
  /** Cents, in the item's `priceBasis`. */
  unitPrice: number;
  taxClass: 'standard' | 'reduced' | 'zero';
  /** Basis points (0 when the item has no default discount). */
  discountBp: number;
}

/** What picking an item gives: the line fields, and the basis their unit price is quoted in. */
export interface LineFromProduct {
  line: ProductLineFields;
  /** Compare with the draft's `netOrGross` before sending `line` (see the file header). */
  priceBasis: 'net' | 'gross';
}

/** The line fields of an item, copied (the item's name is the line's title). */
export function lineFromProduct(
  product: Pick<
    ProductView,
    'kind' | 'name' | 'description' | 'unitLabel' | 'unitPrice' | 'priceBasis' | 'taxClass' | 'discountBp'
  >,
): LineFromProduct {
  return {
    line: {
      kind: product.kind,
      title: product.name,
      description: product.description?.trim() ? product.description : null,
      unitLabel: product.unitLabel,
      unitPrice: product.unitPrice,
      taxClass: product.taxClass,
      discountBp: product.discountBp,
    },
    priceBasis: product.priceBasis,
  };
}
