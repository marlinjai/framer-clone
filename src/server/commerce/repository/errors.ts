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
 * store (MAX_ORDER_INTEGER in src/lib/commerce/dto.ts): caused by the cart (a
 * huge quantity times its price), not a server fault, and thrown before anything
 * is written. The orders route answers it with 422 `order_too_large`.
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
