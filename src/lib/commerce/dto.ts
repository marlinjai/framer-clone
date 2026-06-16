// src/lib/commerce/dto.ts
//
// The b7 commerce REST read DTOs: the typed read shape the /api/commerce/* GET
// routes return, plus the zod schemas that validate every response and the PURE
// mappers from the owned commerce graph (b4 catalog + b5 resolved price + b2/b3
// inventory) onto those DTOs.
//
// This file is deliberately React-free AND server-free: it imports only zod and
// Prisma TYPES (erased at compile), so it is safe to import from the Track C
// storefront client as well as from the server route handlers. The tx-reading
// and price resolution live in the route handlers (they need a Prisma tx); what
// lives here is the pure graph -> DTO projection and the response validation,
// which is what the headless `*.test.ts` unit suite exercises without a database.
//
// PARALLEL READ SURFACE (not the CMS shape): these DTOs carry the rich, typed
// commerce graph (product -> options -> values, product -> variants -> matrix,
// resolved price in integer cents). They are NOT forced through the flat CMS
// Collection/Row shape: the commerce tier shares nothing in the database with the
// CMS tier, so it gets its own read surface.
//
// MONEY IS INTEGER CENTS: resolvedPriceCents is the b5 resolver's integer-cents
// output, carried through unchanged (no float math here). It is nullable because
// b5 resolvePrice returns null when no price applies, and that absence is surfaced
// honestly rather than fabricated as 0.

import { z } from 'zod';
import type { Prisma } from '@prisma/client';

/**
 * The default ISO-4217 currency used to resolve a product's prices when a request
 * does not pin one with `?currency=`. v1 is German-market first (matches the b5/b6
 * EUR tax model), so EUR is the default.
 */
export const DEFAULT_CURRENCY = 'EUR';

// ---------------------------------------------------------------------------
// The Prisma include shape for a full product read. Exported so both the list and
// detail routes read the SAME typed graph. It is pure data (an include literal),
// so it lives here, not in a server-only module. Soft-deleted options / values /
// variants are filtered out at read time (the catalog uses soft-delete).
// ---------------------------------------------------------------------------
export const productGraphInclude = {
  options: {
    where: { deletedAt: null },
    include: { values: { where: { deletedAt: null } } },
  },
  variants: {
    where: { deletedAt: null },
    include: { options: true },
  },
} satisfies Prisma.ProductInclude;

/** A product row read with the full owned graph (options + values + variants + matrix). */
export type ProductGraph = Prisma.ProductGetPayload<{ include: typeof productGraphInclude }>;

// ---------------------------------------------------------------------------
// Response DTO zod schemas. The exported TS types are inferred from these so the
// validator and the type can never drift apart.
// ---------------------------------------------------------------------------

export const productOptionValueDTOSchema = z.object({
  id: z.string(),
  value: z.string(),
});

export const productOptionDTOSchema = z.object({
  id: z.string(),
  title: z.string(),
  values: z.array(productOptionValueDTOSchema),
});

/**
 * One (option, value) assignment for a variant: the typed matrix row, NOT a flat
 * label. The readable labels live on the product's `options[].values[]`; a client
 * joins by id. Carrying the ids keeps the variant shape faithful to the owned
 * variant<->option matrix without re-denormalizing it.
 */
export const productVariantOptionDTOSchema = z.object({
  optionId: z.string(),
  optionValueId: z.string(),
});

export const productVariantDTOSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  // Integer cents (b5), or null when no price applies to this variant.
  resolvedPriceCents: z.number().int().nullable(),
  options: z.array(productVariantOptionDTOSchema),
});

export const productDTOSchema = z.object({
  id: z.string(),
  handle: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  options: z.array(productOptionDTOSchema),
  variants: z.array(productVariantDTOSchema),
  // A product-level "from" price: the LOWEST resolved variant price in integer
  // cents, or null when no variant has an applicable price. Per-variant prices
  // live on `variants[].resolvedPriceCents`.
  resolvedPriceCents: z.number().int().nullable(),
});

export const productListResponseSchema = z.object({
  products: z.array(productDTOSchema),
  nextCursor: z.string().optional(),
});

/**
 * Inventory availability for one variant at one location.
 *
 * ADVISORY-ONLY (cross-check doc section 4.4; b7 spec). `availableQuantity` mirrors
 * the b2 generated column `inventory_level.available_quantity`
 * (= stocked_quantity - reserved_quantity) at read time, with FIRE-AND-FORGET
 * freshness. It is NOT a reservation and NOT permission to complete a sale: it can
 * be stale the instant it is read. The b3 guarded conditional reserve is the SOLE
 * authority on whether stock can be taken, and it rejects at reserve time against
 * the live, write-locked row regardless of any number read here. The `advisoryOnly:
 * true` literal makes that contract explicit in the payload itself, so no client
 * path can treat this read as a sale guarantee.
 */
export const availabilityDTOSchema = z.object({
  variantId: z.string(),
  locationId: z.string(),
  availableQuantity: z.number().int(),
  advisoryOnly: z.literal(true),
});

export type ProductOptionValueDTO = z.infer<typeof productOptionValueDTOSchema>;
export type ProductOptionDTO = z.infer<typeof productOptionDTOSchema>;
export type ProductVariantOptionDTO = z.infer<typeof productVariantOptionDTOSchema>;
export type ProductVariantDTO = z.infer<typeof productVariantDTOSchema>;
export type ProductDTO = z.infer<typeof productDTOSchema>;
export type ProductListResponse = z.infer<typeof productListResponseSchema>;
export type AvailabilityDTO = z.infer<typeof availabilityDTOSchema>;

// ---------------------------------------------------------------------------
// Pure mappers: commerce graph -> DTO. No I/O, no tx, no React. The per-variant
// resolved prices are computed by the caller (which holds the tx) and passed in.
// ---------------------------------------------------------------------------

/**
 * Project a product graph plus its per-variant resolved prices onto a ProductDTO.
 * The product-level `resolvedPriceCents` is the lowest non-null variant price (a
 * storefront "from" price), or null when no variant has an applicable price.
 */
export function toProductDTO(
  graph: ProductGraph,
  priceByVariantId: ReadonlyMap<string, number | null>,
): ProductDTO {
  const variants: ProductVariantDTO[] = graph.variants.map((variant) => ({
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    barcode: variant.barcode,
    resolvedPriceCents: priceByVariantId.get(variant.id) ?? null,
    options: variant.options.map((assignment) => ({
      optionId: assignment.optionId,
      optionValueId: assignment.optionValueId,
    })),
  }));

  const variantPrices = variants
    .map((variant) => variant.resolvedPriceCents)
    .filter((price): price is number => price != null);
  const resolvedPriceCents = variantPrices.length > 0 ? Math.min(...variantPrices) : null;

  return {
    id: graph.id,
    handle: graph.handle,
    title: graph.title,
    description: graph.description,
    options: graph.options.map((option) => ({
      id: option.id,
      title: option.title,
      values: option.values.map((value) => ({ id: value.id, value: value.value })),
    })),
    variants,
    resolvedPriceCents,
  };
}

/**
 * Build the AvailabilityDTO, stamping the advisory-only marker. See
 * availabilityDTOSchema: the number is fire-and-forget freshness, never a sale
 * guarantee (the b3 guarded reserve is the sole authority).
 */
export function toAvailabilityDTO(input: {
  variantId: string;
  locationId: string;
  availableQuantity: number;
}): AvailabilityDTO {
  return {
    variantId: input.variantId,
    locationId: input.locationId,
    availableQuantity: input.availableQuantity,
    advisoryOnly: true,
  };
}
