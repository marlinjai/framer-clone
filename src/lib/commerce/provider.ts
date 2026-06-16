// CommerceDataSource: the READ-ONLY seam between the storefront and whatever
// is delivering the commerce graph (in-memory test double today, an HTTP
// client over Track B's /api/commerce/* routes tomorrow). Storefront
// components never import a concrete provider; they go through
// useCommerceDataSource() so the implementation is swappable at the root,
// exactly like the CMS DataSourceProvider seam this mirrors.
//
// READS ONLY, by design. There is intentionally NO write/reserve/adjust method
// anywhere on this interface: catalog mutation and stock reservation are Track
// B, server-authoritative. Availability is ADVISORY (see AvailabilityDTO):
// surfaced as information, never as permission to sell. This file is React-free
// and Node-evaluable.

import type {
  AvailabilityDTO,
  CommerceQuery,
  PriceDTO,
  ProductDTO,
  ProductPage,
  ProductVariantDTO,
} from './types';

export interface CommerceDataSource {
  /** List products (filter/sort/limit). Returns a page plus total. */
  listProducts(query?: CommerceQuery): Promise<ProductPage>;

  /** A single product by id, or null when no such product exists. */
  getProduct(productId: string): Promise<ProductDTO | null>;

  /** A single product by its handle, or null when no such product exists. */
  getProductByHandle(handle: string): Promise<ProductDTO | null>;

  /** Every variant of a product (empty array when the product has none). */
  listVariants(productId: string): Promise<ProductVariantDTO[]>;

  /** A single variant by id, or null when no such variant exists. */
  getVariant(variantId: string): Promise<ProductVariantDTO | null>;

  /** Price rows for a variant (empty array when the variant has no prices). */
  getPrices(variantId: string): Promise<PriceDTO[]>;

  /**
   * ADVISORY availability for a variant. When locationId is omitted the value
   * is aggregated across every location. Throws when the variant does not
   * exist (a missing record must never be reported as success). The returned
   * quantity is information only, never permission to sell.
   */
  getAvailability(
    variantId: string,
    locationId?: string,
  ): Promise<AvailabilityDTO>;

  /**
   * Polling-style subscription. The provider invokes `onChange` whenever data
   * for the given product (or, when productId is null, any product) may have
   * changed. Returns an unsubscribe function.
   *
   * The in-memory double fires on internal mutate; the future HTTP provider
   * picks its own polling cadence. Real-time push channels are out of scope.
   */
  subscribe(productId: string | null, onChange: () => void): () => void;
}
