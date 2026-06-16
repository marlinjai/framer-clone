// Typed commerce DTOs: the rich, read-only graph the storefront resolves
// through CommerceDataSource. This is a SECOND seam alongside the flat CMS
// Collection/Row shape (src/lib/bindings/dataSource/types.ts), carrying a
// proper catalog/price/availability graph instead.
//
// These DTOs are the client-facing contract. Track B owns the Prisma models
// (commerce.product, product_option, product_variant, price, inventory_level,
// ...); the provider maps those rows INTO these DTOs and never leaks Prisma
// types past this boundary. This file is React-free and Node-evaluable.

/**
 * A single resolved value of a product option (e.g. the "Small" value of a
 * "Size" option). Mirrors commerce.product_option_value.
 */
export interface ProductOptionValueDTO {
  id: string;
  optionId: string;
  /** The option value string (e.g. "Small", "Red"). Maps from row.value. */
  label: string;
}

/**
 * A product option axis (e.g. "Size", "Color"). Mirrors
 * commerce.product_option with its values eagerly attached.
 */
export interface ProductOptionDTO {
  id: string;
  productId: string;
  /** Display title of the axis (e.g. "Size"). */
  title: string;
  values: ProductOptionValueDTO[];
}

/**
 * A resolved option coordinate on a variant: which value of which option this
 * variant occupies, with the human label denormalized for display. Mirrors a
 * commerce.product_variant_option row joined to its option_value.
 */
export interface VariantOptionCoordinate {
  optionId: string;
  valueId: string;
  label: string;
}

/**
 * A purchasable variant. Mirrors commerce.product_variant plus its resolved
 * option coordinates. title is nullable in Track B (a single-variant product
 * may leave it unset), so it is a required key with a nullable value.
 */
export interface ProductVariantDTO {
  id: string;
  productId: string;
  title: string | null;
  sku?: string;
  barcode?: string;
  /**
   * Catalog-side tax classification (b5). A classification string, never a
   * rate. Falls back to the product's taxClass when the variant leaves it
   * unset (resolution itself is a downstream engine's job).
   */
  taxClass?: string;
  optionValues: VariantOptionCoordinate[];
}

/**
 * A product with its option axes and the ids of its variants. Variants are
 * fetched separately (listVariants/getVariant) to keep the product payload
 * lean. Mirrors commerce.product.
 */
export interface ProductDTO {
  id: string;
  handle: string;
  title: string;
  description: string | null;
  /** Catalog-side tax classification (b5). A classification string, never a rate. */
  taxClass?: string;
  options: ProductOptionDTO[];
  variantIds: string[];
}

/**
 * A price row for a variant. amount is ALWAYS integer minor units (cents),
 * never a float: Track B stores commerce.price.amount as an Int and the
 * database physically cannot hold a fractional value. min/max quantity scope
 * the price to a quantity band (quantity-break pricing) when present.
 */
export interface PriceDTO {
  variantId: string;
  amountCents: number;
  currency: string;
  /** Resolved catalog-side tax classification (variant taxClass, else product). */
  taxClass?: string;
  minQuantity?: number;
  maxQuantity?: number;
}

/**
 * ADVISORY availability for a variant at a location. availableQuantity surfaces
 * commerce.inventory_level.available_quantity (the GENERATED stocked - reserved
 * column). It is information only and is NEVER permission to sell: Track B
 * remains server-authoritative for stock and writes. `stale` flags a value that
 * may be out of date (the future HTTP provider sets it when its poll cache is
 * old; the in-memory double is always fresh).
 *
 * When availability is requested without a locationId, the provider aggregates
 * across locations and reports `locationId` as the sentinel "all".
 */
export interface AvailabilityDTO {
  variantId: string;
  locationId: string;
  availableQuantity: number;
  stale: boolean;
}

/** Sentinel locationId for an availability aggregated across every location. */
export const ALL_LOCATIONS = 'all';

export type CommerceFilterOp = 'eq' | 'ne' | 'contains';

export interface CommerceFilterClause {
  /** A filterable product field: 'handle' or 'title'. */
  field: 'handle' | 'title';
  op: CommerceFilterOp;
  value: string;
}

export interface CommerceSortClause {
  field: 'title' | 'handle';
  direction: 'asc' | 'desc';
}

export interface CommerceQuery {
  filter?: CommerceFilterClause[];
  sort?: CommerceSortClause[];
  limit?: number;
  /** Opaque cursor; the HTTP provider owns the encoding when it lands. */
  cursor?: string;
}

export interface ProductPage {
  products: ProductDTO[];
  nextCursor?: string;
  /** Total matching the filter, ignoring limit. */
  total: number;
}
