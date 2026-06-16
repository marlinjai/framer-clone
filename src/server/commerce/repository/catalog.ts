import 'server-only';

// src/server/commerce/repository/catalog.ts
//
// The b4 CatalogRepository implementation over the passed transaction client.
// This is the write surface for the owned typed catalog (product / option /
// option_value / variant + the variant<->option matrix). It is React-free and
// Node-evaluable: it imports only the Prisma types and the commerce schema
// constant, takes a `tx` first on every method (the b1 tx-first rule), and never
// opens its own transaction or touches a bare PrismaClient. A caller (a mutation
// route, a realtime consumer) opens a `withTenant` block and hands the tx in.
//
// Catalog CONTENT only: NO price (b5), NO inventory linkage (b2/b3), NO Yjs (E5).
//
// The two database-level correctness guarantees this repository RELIES ON (both
// added by the b4 migration, neither re-implemented in app code):
//   1. the COMPOSITE FK on product_variant_option ensures an option_value can
//      only be attached under its OWN option_id; setVariantOptions therefore does
//      not re-check the pairing in JS: a wrong pairing throws from Postgres.
//   2. the option_signature recompute triggers derive a variant's signature from
//      the matrix, and the partial-UNIQUE rejects a duplicate combination. The
//      authoritative trigger fires AFTER INSERT/UPDATE/DELETE on the matrix table
//      (product_variant_option) itself, so setVariantOptions does NOT touch the
//      variant row at all: the matrix writes alone recompute the signature, no
//      matter who writes the matrix. A duplicate combination throws.
//
// Errors surface: a composite-FK rejection, a signature collision, or any other
// constraint violation propagates to the caller (whose transaction rolls back).
// Nothing is caught-and-ignored here.

import type {
  CatalogRepository,
  AddOptionInput,
  AddOptionValueInput,
  AddVariantInput,
  CreateProductInput,
  VariantOptionAssignment,
} from './types';
import type { Prisma, Product, ProductOption, ProductOptionValue, ProductVariant } from '@prisma/client';

export const catalogRepository: CatalogRepository = {
  count(tx: Prisma.TransactionClient): Promise<number> {
    return tx.product.count();
  },

  createProduct(tx: Prisma.TransactionClient, input: CreateProductInput): Promise<Product> {
    return tx.product.create({
      data: {
        title: input.title,
        handle: input.handle,
        description: input.description ?? null,
        // status defaults to 'draft' at the DB; pass it through only when given.
        ...(input.status ? { status: input.status } : {}),
      },
    });
  },

  addOption(tx: Prisma.TransactionClient, input: AddOptionInput): Promise<ProductOption> {
    return tx.productOption.create({
      data: { productId: input.productId, title: input.title },
    });
  },

  addOptionValue(
    tx: Prisma.TransactionClient,
    input: AddOptionValueInput,
  ): Promise<ProductOptionValue> {
    return tx.productOptionValue.create({
      data: { optionId: input.optionId, value: input.value },
    });
  },

  addVariant(tx: Prisma.TransactionClient, input: AddVariantInput): Promise<ProductVariant> {
    // option_signature is omitted: the BEFORE INSERT trigger sets it (NULL here,
    // since the variant has no matrix rows yet). It is absent from the Prisma
    // model, so it cannot be written from app code by construction.
    return tx.productVariant.create({
      data: {
        productId: input.productId,
        title: input.title ?? null,
        sku: input.sku ?? null,
        barcode: input.barcode ?? null,
      },
    });
  },

  async setVariantOptions(
    tx: Prisma.TransactionClient,
    variantId: string,
    assignments: VariantOptionAssignment[],
  ): Promise<void> {
    // Replace the matrix for this variant: clear, then re-insert. The composite
    // FK rejects any (optionValueId, optionId) that is not a real pair in
    // product_option_value, so a wrong pairing throws here (no JS re-check).
    await tx.productVariantOption.deleteMany({ where: { variantId } });

    for (const assignment of assignments) {
      await tx.productVariantOption.create({
        data: {
          variantId,
          optionId: assignment.optionId,
          optionValueId: assignment.optionValueId,
        },
      });
    }

    // No variant-row touch is needed: the AFTER INSERT/UPDATE/DELETE trigger on
    // product_variant_option recomputes option_signature from the now-current
    // matrix on every matrix write above. If another LIVE variant already owns this
    // exact option combination, the option_signature partial-UNIQUE rejects the
    // recompute UPDATE the trigger issues and the error propagates (the caller's
    // transaction rolls back).
  },
};
