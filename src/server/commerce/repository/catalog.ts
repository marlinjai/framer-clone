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

// CM-06 EXPAND imports — the Kysely path lives ALONGSIDE the Prisma path below.
import { randomUUID } from 'node:crypto';
import type { Kysely, Insertable, Selectable } from 'kysely';
import type {
  CommerceDB,
  ProductTable,
  ProductOptionTable,
  ProductOptionValueTable,
  ProductVariantTable,
} from '../db-types';

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

// =============================================================================
// CM-06 EXPAND — the Kysely catalog repository (NEW), added ALONGSIDE the Prisma
// `catalogRepository` above. The two paths COEXIST through CM-12 (plan §10): the
// old Prisma object keeps every current caller (`createOrder.ts`,
// `products/route.ts`, the existing tests) compiling and serving the demo, while
// this Kysely object is "dark" — wired by no caller until CM-10 flips routes/
// render to it; CM-13 then deletes the Prisma path. So nothing below changes a
// single existing signature: this is a pure ADDITION (expand-contract).
//
// Each method takes a `db: Kysely<CommerceDB>` first — the per-request scoped
// handle (`commerceTenantDb(tgId)`), whose every bare table identifier is already
// rewritten to `tg_<id>.<table>` by `withSchema`. So there is no `tx`-first rule,
// no `withTenant`, and no schema string: isolation is baked into the handle.
//
// id / updated_at are SUPPLIED by app code. The CM-04 per-tenant DDL declares
// `id TEXT NOT NULL` and `updated_at TIMESTAMP(3) NOT NULL` with NO database
// default (Prisma drove `@default(cuid())` / `@updatedAt` app-side, never the
// DB), so CM-05 types both as plain (non-`Generated<>`) columns — i.e. REQUIRED
// on insert. We mint a uuid per row and stamp `updated_at` with the current time,
// exactly as the Prisma client did implicitly. `option_signature` is OMITTED
// everywhere: it is `Generated<>` and owned solely by the catalog triggers.
//
// The two database-level guarantees this repo relies on (composite FK +
// option_signature recompute triggers) are unchanged from the header above and
// are NOT re-checked in JS here — Postgres remains authoritative.
// =============================================================================

/** RETURNING/SELECT projections returned by the Kysely catalog repo. */
export type CatalogProductRow = Selectable<ProductTable>;
export type CatalogOptionRow = Selectable<ProductOptionTable>;
export type CatalogOptionValueRow = Selectable<ProductOptionValueTable>;
export type CatalogVariantRow = Selectable<ProductVariantTable>;

/**
 * The Kysely mirror of {@link CatalogRepository}, generic over the scoped
 * `Kysely<CommerceDB>` handle instead of a Prisma `tx`. Co-located here (NOT in
 * `repository/types.ts`) so this spec never touches the file CM-08/CM-09 edit.
 */
export interface CatalogRepositoryKysely {
  /** Count catalog entries (products) visible in the scoped tenant schema. */
  count(db: Kysely<CommerceDB>): Promise<number>;

  /** Create a product (status defaults to 'draft' at the DB when omitted). */
  createProduct(db: Kysely<CommerceDB>, input: CreateProductInput): Promise<CatalogProductRow>;

  /** Add an option (e.g. "Color") to a product. */
  addOption(db: Kysely<CommerceDB>, input: AddOptionInput): Promise<CatalogOptionRow>;

  /** Add a value (e.g. "Red") to an option. */
  addOptionValue(
    db: Kysely<CommerceDB>,
    input: AddOptionValueInput,
  ): Promise<CatalogOptionValueRow>;

  /** Add a variant to a product (its option_signature starts NULL, trigger-set). */
  addVariant(db: Kysely<CommerceDB>, input: AddVariantInput): Promise<CatalogVariantRow>;

  /**
   * Replace a variant's option assignments (the matrix). The composite FK rejects
   * a wrong (option, value) pairing; the option_signature partial-UNIQUE rejects a
   * combination already owned by another live variant. Both surface as throws and
   * roll back the wrapping transaction.
   */
  setVariantOptions(
    db: Kysely<CommerceDB>,
    variantId: string,
    assignments: VariantOptionAssignment[],
  ): Promise<void>;
}

export const catalogRepositoryKysely: CatalogRepositoryKysely = {
  async count(db: Kysely<CommerceDB>): Promise<number> {
    const row = await db
      .selectFrom('product')
      .select(db.fn.countAll().as('c'))
      .executeTakeFirstOrThrow();
    return Number(row.c);
  },

  createProduct(db: Kysely<CommerceDB>, input: CreateProductInput): Promise<CatalogProductRow> {
    const values: Insertable<ProductTable> = {
      id: randomUUID(),
      title: input.title,
      handle: input.handle,
      description: input.description ?? null,
      updated_at: new Date(),
    };
    // status is Generated<> (DB default 'draft'); pass it through only when given.
    if (input.status) values.status = input.status;
    return db.insertInto('product').values(values).returningAll().executeTakeFirstOrThrow();
  },

  addOption(db: Kysely<CommerceDB>, input: AddOptionInput): Promise<CatalogOptionRow> {
    return db
      .insertInto('product_option')
      .values({
        id: randomUUID(),
        product_id: input.productId,
        title: input.title,
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  addOptionValue(
    db: Kysely<CommerceDB>,
    input: AddOptionValueInput,
  ): Promise<CatalogOptionValueRow> {
    return db
      .insertInto('product_option_value')
      .values({
        id: randomUUID(),
        option_id: input.optionId,
        value: input.value,
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  addVariant(db: Kysely<CommerceDB>, input: AddVariantInput): Promise<CatalogVariantRow> {
    // option_signature is OMITTED: it is Generated<> and the BEFORE INSERT trigger
    // sets it (NULL here, since the variant has no matrix rows yet).
    return db
      .insertInto('product_variant')
      .values({
        id: randomUUID(),
        product_id: input.productId,
        title: input.title ?? null,
        sku: input.sku ?? null,
        barcode: input.barcode ?? null,
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  async setVariantOptions(
    db: Kysely<CommerceDB>,
    variantId: string,
    assignments: VariantOptionAssignment[],
  ): Promise<void> {
    // Replace the matrix for this variant: clear, then bulk re-insert, in ONE
    // transaction so the clear+insert is atomic. The composite FK rejects any
    // (option_value_id, option_id) that is not a real pair (no JS re-check), and
    // the AFTER INSERT/UPDATE/DELETE matrix trigger recomputes option_signature
    // from the now-current matrix — the variant row is never touched here.
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('product_variant_option')
        .where('variant_id', '=', variantId)
        .execute();

      if (assignments.length > 0) {
        await trx
          .insertInto('product_variant_option')
          .values(
            assignments.map((assignment) => ({
              variant_id: variantId,
              option_id: assignment.optionId,
              option_value_id: assignment.optionValueId,
            })),
          )
          .execute();
      }
    });
  },
};
