// src/server/commerce/repository/errors.ts
//
// Typed errors of the commerce read repositories, in a module of their own so the storefront reads
// (storefront.ts) and the catalogue reads (read.ts), which import each other's helpers, can both throw them.

/**
 * A cart line names a variant that does not exist (or is soft-deleted) in THIS
 * tenant group: a client-side problem (a stale cart, or another shop's id), not
 * a server fault. The orders route answers it with 422 `unknown_variant`.
 */
export class UnknownVariantError extends Error {
  readonly code = 'UNKNOWN_VARIANT';
  constructor(readonly variantId: string) {
    super(`unknown variant ${variantId}`);
    this.name = 'UnknownVariantError';
  }
}

/**
 * An order whose quantity, line amount or total exceeds what its INTEGER columns
 * store (MAX_ORDER_INTEGER in src/lib/commerce/dto.ts), whose backorder would take
 * the reserved stock past its column, or whose total is more than its payment
 * provider takes in one charge (maxChargeAmount, payment/provider.ts): caused by
 * the cart (a huge quantity times its price), not a server fault, and nothing of it
 * is kept. The orders route answers it with 422 `order_too_large`.
 */
export class OrderTooLargeError extends Error {
  readonly code = 'ORDER_TOO_LARGE';
  constructor(
    /** The line that went over, or null when only the order's sum did. */
    readonly variantId: string | null,
    readonly label: string,
    readonly value: number,
  ) {
    super(`order too large: ${label} ${value} exceeds the stored maximum${variantId ? ` (variant ${variantId})` : ''}`);
    this.name = 'OrderTooLargeError';
  }
}
