// src/lib/books/products.ts
//
// From an item of the company's product and service list to the body of a new
// draft line (invoice editor plan, phase 4; the line search of phase 3 calls
// it and sends the result to POST /api/books/documents/<id>/lines with the
// draft's version). A line COPIES these values when an item is picked and keeps
// no reference to the item (migration 015_books_products, guarantee 1): editing
// or archiving the item later never changes the line.
//
// The unit price is sent in the basis the item is quoted in (`priceBasis`).
// When the draft is in the other basis (net or gross), the SERVER converts the
// price under the draft's tax profile and stores it in the draft's basis
// (repository/lines.ts, convertUnitPrice in totals.ts): the client never
// converts, as figures are the server's (plan decision 3).
//
// Client-safe: no server imports.

import type { ProductView } from './api';
import { foldKey } from './searchKey';

/** The unit a new item gets when none is given (the database default too). */
export const DEFAULT_PRODUCT_UNIT = 'Stk';

/** The longest folded name (migration 015's `name_key` bound; the fold can grow a name). */
export const MAX_NAME_KEY_LENGTH = 600;

/**
 * What is wrong with an item's name (already trimmed), or null: the one rule
 * the form and the server both apply. At most 300 characters (a line title),
 * at least one letter or digit, and a folded form within the stored bound.
 */
export function productNameProblem(name: string): string | null {
  if (name === '') return 'Enter a name.';
  if (name.length > 300) return 'Use at most 300 characters.';
  if (!/[\p{L}\p{N}]/u.test(name)) return 'A name needs at least one letter or digit.';
  if (foldKey(name).length > MAX_NAME_KEY_LENGTH) return 'This name is too long once its combined characters are spelled out; shorten it.';
  return null;
}

/** The fields of a new draft line an item fills: a body of POST .../lines, without quantity and version. */
export interface ProductLineFields {
  kind: 'service' | 'product';
  title: string;
  description: string | null;
  unitLabel: string;
  /** Cents, in `priceBasis`. */
  unitPrice: number;
  /** The basis `unitPrice` is quoted in; the server converts it when the draft's differs. */
  priceBasis: 'net' | 'gross';
  taxClass: 'standard' | 'reduced' | 'zero';
  /** Basis points (0 when the item has no default discount). */
  discountBp: number;
}

/** The line fields of an item, copied (the item's name is the line's title). */
export function lineFromProduct(
  product: Pick<
    ProductView,
    'kind' | 'name' | 'description' | 'unitLabel' | 'unitPrice' | 'priceBasis' | 'taxClass' | 'discountBp'
  >,
): ProductLineFields {
  return {
    kind: product.kind,
    title: product.name,
    description: product.description?.trim() ? product.description : null,
    unitLabel: product.unitLabel,
    unitPrice: product.unitPrice,
    priceBasis: product.priceBasis,
    taxClass: product.taxClass,
    discountBp: product.discountBp,
  };
}
