// src/lib/books/products.ts
//
// From an item of the company's catalogue (GET /api/books/catalogue, a
// sellable variant of a product or service) to the body of a draft line
// (catalogue design, "The Books' own list is replaced"; the invoice editor's
// line search calls it and sends the result to POST
// /api/books/documents/<id>/lines with the draft's version). A line COPIES
// these values when an item is picked and stores the variant id as its only
// reference (`variantRef`, the line's `variant_ref`). The reference is
// informational: editing or archiving the item in the catalogue later never
// changes the line.
//
// The unit price is sent in the basis the item is quoted in (`priceBasis`).
// When the draft is in the other basis (net or gross), the SERVER converts the
// price under the draft's tax profile and stores it in the draft's basis
// (repository/lines.ts, convertUnitPrice in totals.ts): the client never
// converts, as figures are the server's (plan decision 3).
//
// Client-safe: no server imports.

import type { CatalogueItemView } from './api';

/** The fields of a draft line a catalogue item fills: a body of POST .../lines, without quantity and version. */
export interface ProductLineFields {
  kind: 'service' | 'product';
  title: string;
  description: string | null;
  unitLabel: string;
  /** Cents, in `priceBasis`. */
  unitPrice: number;
  /** The basis `unitPrice` is quoted in; the server converts it when the draft's differs. */
  priceBasis: 'net' | 'gross';
  /** Null rates as standard (the line table's rule). */
  taxClass: 'standard' | 'reduced' | 'zero' | null;
  /** Basis points (0 when the item has no default discount). */
  discountBp: number;
  /** The catalogue variant the line was picked from, its only reference. */
  variantRef: string;
}

/** The line fields of a catalogue item, copied, with the variant as the line's reference. */
export function lineFromProduct(
  item: Pick<
    CatalogueItemView,
    'variantId' | 'kind' | 'title' | 'description' | 'unitLabel' | 'unitPrice' | 'priceBasis' | 'taxClass' | 'discountBp'
  >,
): ProductLineFields {
  return {
    kind: item.kind,
    title: item.title,
    description: item.description?.trim() ? item.description : null,
    unitLabel: item.unitLabel,
    unitPrice: item.unitPrice,
    priceBasis: item.priceBasis,
    taxClass: item.taxClass,
    discountBp: item.discountBp,
    variantRef: item.variantId,
  };
}
