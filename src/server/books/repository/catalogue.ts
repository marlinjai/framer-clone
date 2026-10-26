// src/server/books/repository/catalogue.ts
//
// The company's catalogue as the invoice line picker sees it (catalogue design,
// docs/plans/2026-10-25-catalogue-design.md: "The Books' own list is
// replaced"). Every sellable item resolves to a variant: a service has exactly
// one, a physical product one per live variant (020_catalogue_company,
// guarantee 5). An item here is what a draft line COPIES when it is picked
// (src/lib/books/products.ts, lineFromProduct): title, plain description, unit
// label, unit price in cents with the basis it is quoted in, tax class, default
// discount and kind, plus the variant id the line keeps as its only reference
// (`variant_ref`, informational: the copied values stay authoritative, so a
// later catalogue edit never changes a line).
//
// Offered: the company's products that are neither archived nor deleted, in
// any status (the Books items 020 moved into the catalogue are drafts), each
// live variant that has a base price in EUR for one unit (no price list, the
// quantity-1 tier, the lowest when several apply: what pricing.ts selectPrice
// picks for a plain sale). A variant without such a price is not offered, as a
// line needs a price and the catalogue has none to copy.
//
// Every query filters on the company on every joined table: another
// company's products never appear, even within the same tenant group.

import { searchWords } from '@/lib/books/searchKey';

import { invalid } from '../errors';
import type { BooksScope } from '../scope';

/** The longest search the picker sends (characters). */
export const MAX_SEARCH_LENGTH = 100;

/** The most items one search answers (the picker shows the first ones; typing narrows). */
export const CATALOGUE_SEARCH_LIMIT = 50;

const TAX_CLASSES = ['standard', 'reduced', 'zero'] as const;
export type CatalogueTaxClass = (typeof TAX_CLASSES)[number];

/** One sellable variant of the catalogue, with what a line copies from it. */
export interface CatalogueItem {
  /** The variant a picked line references (`variant_ref`). */
  variantId: string;
  productId: string;
  /** 'service' for a catalogue service, 'product' for a physical product (the line kinds). */
  kind: 'service' | 'product';
  /** The product title, with the variant title in brackets when it says more (as lines.ts variantDefaults). */
  title: string;
  description: string | null;
  unitLabel: string;
  /** Cents, in `priceBasis`. */
  unitPrice: number;
  priceBasis: 'net' | 'gross';
  /** The variant's class, else the product's; null rates as standard (the line table's rule). */
  taxClass: CatalogueTaxClass | null;
  /** Basis points. */
  discountBp: number;
  /** The catalogue status (a draft is offered too: the Books need no shop). */
  status: 'draft' | 'published';
}

/**
 * The line title of a variant: the product title, with the variant title in
 * brackets when it is set and differs, at most 300 characters (a line title).
 * The one rule for both a picked line and a line added by `variantRef` alone.
 */
export function variantLineTitle(productTitle: string, variantTitle: string | null): string {
  const v = variantTitle?.trim() ?? '';
  const title = v !== '' && v !== productTitle ? `${productTitle} (${v})` : productTitle;
  return title.slice(0, 300);
}

/** A catalogue tax class the line table accepts, else null (rated as standard, as resolveLineRate does). */
export function lineTaxClass(raw: string | null): CatalogueTaxClass | null {
  return (TAX_CLASSES as readonly string[]).includes(raw ?? '') ? (raw as CatalogueTaxClass) : null;
}

/** LIKE pattern for a folded word, its metacharacters escaped. */
function containsPattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The company's sellable variants matching `q`, by product title, then the
 * variant's creation. `q` is folded like `product.search_text`
 * (src/lib/books/searchKey.ts); every word must occur in the product's search
 * text, or in its title or the variant's title (lower-cased), so a product
 * whose search text was never written is still found by its title.
 */
export async function searchCatalogue(scope: BooksScope, q = ''): Promise<CatalogueItem[]> {
  if (q.length > MAX_SEARCH_LENGTH) {
    throw invalid('INVALID_INPUT', [{ path: ['q'], message: `at most ${MAX_SEARCH_LENGTH} characters` }]);
  }
  const words = searchWords(q);
  const tenantId = scope.tenantId;

  let query = scope.db
    .selectFrom('product')
    .innerJoin('product_variant', (join) =>
      join
        .onRef('product_variant.product_id', '=', 'product.id')
        .onRef('product_variant.tenant_id', '=', 'product.tenant_id'),
    )
    .innerJoin(
      (eb) =>
        eb
          .selectFrom('price')
          .innerJoin('price_set', (join) =>
            join.onRef('price_set.id', '=', 'price.price_set_id').onRef('price_set.tenant_id', '=', 'price.tenant_id'),
          )
          .select(['price_set.variant_id as variant_id', (b) => b.fn.min('price.amount').as('amount')])
          .where('price.tenant_id', '=', tenantId)
          .where('price_set.tenant_id', '=', tenantId)
          .where('price.price_list_id', 'is', null)
          .where('price.currency_code', '=', 'EUR')
          .where((b) => b.or([b('price.min_quantity', 'is', null), b('price.min_quantity', '<=', 1)]))
          .where((b) => b.or([b('price.max_quantity', 'is', null), b('price.max_quantity', '>=', 1)]))
          .groupBy('price_set.variant_id')
          .as('base'),
      (join) => join.onRef('base.variant_id', '=', 'product_variant.id'),
    )
    .select([
      'product.id as productId',
      'product.title as productTitle',
      'product.description as description',
      'product.kind as kind',
      'product.status as status',
      'product.unit_label as unitLabel',
      'product.price_basis as priceBasis',
      'product.tax_class as productTaxClass',
      'product.discount_bp as discountBp',
      'product_variant.id as variantId',
      'product_variant.title as variantTitle',
      'product_variant.tax_class as variantTaxClass',
      'base.amount as amount',
    ])
    .where('product.tenant_id', '=', tenantId)
    .where('product_variant.tenant_id', '=', tenantId)
    .where('product.deleted_at', 'is', null)
    .where('product.archived_at', 'is', null)
    .where('product_variant.deleted_at', 'is', null);
  for (const word of words) {
    const pattern = containsPattern(word);
    query = query.where((eb) =>
      eb.or([
        eb(eb.fn.coalesce('product.search_text', eb.val('')), 'like', pattern),
        eb(eb.fn('lower', ['product.title']), 'like', pattern),
        eb(eb.fn('lower', [eb.fn.coalesce('product_variant.title', eb.val(''))]), 'like', pattern),
      ]),
    );
  }
  const rows = await query
    .orderBy('product.title')
    .orderBy('product.id')
    .orderBy('product_variant.created_at')
    .orderBy('product_variant.id')
    .limit(CATALOGUE_SEARCH_LIMIT)
    .execute();

  return rows.map((r) => ({
    variantId: r.variantId,
    productId: r.productId,
    kind: r.kind === 'service' ? 'service' : 'product',
    title: variantLineTitle(r.productTitle, r.variantTitle),
    description: r.description?.trim() ? r.description : null,
    unitLabel: r.unitLabel,
    unitPrice: Number(r.amount),
    priceBasis: r.priceBasis === 'net' ? 'net' : 'gross',
    taxClass: lineTaxClass(r.variantTaxClass ?? r.productTaxClass),
    discountBp: r.discountBp,
    status: r.status === 'published' ? 'published' : 'draft',
  }));
}
