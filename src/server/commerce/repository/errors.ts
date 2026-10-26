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
