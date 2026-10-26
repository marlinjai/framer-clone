import 'server-only';

// src/server/commerce/repository/catalog.ts
//
// The CatalogRepository: the write surface for the owned typed catalog (product /
// option / option_value / variant + the variant<->option matrix). React-free and
// Node-evaluable. Every method takes the scoped handle `db: Kysely<CommerceDB>`
// first (`commerceTenantDb(tgId)`, or a transaction opened on it), whose every
// table identifier tenant-db's `withSchema` already rewrote to `tg_<id>.<table>`,
// so there is no schema string anywhere here.
//
// Catalog CONTENT only: NO price (pricing.ts), NO inventory linkage (reserve.ts).
//
// The two database-level correctness guarantees this repository RELIES ON (both
// in the per-tenant migration 003_catalog, neither re-implemented in app code):
//   1. the COMPOSITE FK on product_variant_option ensures an option_value can
//      only be attached under its OWN option_id; setVariantOptions therefore does
//      not re-check the pairing in JS: a wrong pairing throws from Postgres.
//   2. the option_signature recompute triggers derive a variant's signature from
//      the matrix, and the partial-UNIQUE rejects a duplicate combination. The
//      authoritative trigger fires AFTER INSERT/UPDATE/DELETE on the matrix table
//      (product_variant_option) itself, so setVariantOptions does NOT touch the
//      variant row at all.
//
// id / updated_at are SUPPLIED by app code: the per-tenant DDL declares
// `id TEXT NOT NULL` and `updated_at TIMESTAMP(3) NOT NULL` with no database
// default, so db-types.ts types both as required on insert. `option_signature`
// is `Generated<>` and owned solely by the catalog triggers, so it is never
// written here.
//
// Errors surface: a composite-FK rejection, a signature collision, or any other
// constraint violation propagates to the caller (whose transaction rolls back).
// Nothing is caught-and-ignored here.

import { randomUUID } from 'node:crypto';
import type { Kysely, Insertable } from 'kysely';

import type { CommerceDB, ProductTable } from '../db-types';
import type {
  AddOptionInput,
  AddOptionValueInput,
  AddVariantInput,
  CatalogOptionRow,
  CatalogOptionValueRow,
  CatalogProductRow,
  CatalogRepository,
  CatalogVariantRow,
  CreateProductInput,
  VariantOptionAssignment,
} from './types';

export const catalogRepository: CatalogRepository = {
  async count(db: Kysely<CommerceDB>, tenantId: string): Promise<number> {
    const row = await db
      .selectFrom('product')
      .select(db.fn.countAll().as('c'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    return Number(row.c);
  },

  createProduct(db: Kysely<CommerceDB>, input: CreateProductInput): Promise<CatalogProductRow> {
    const values: Insertable<ProductTable> = {
      id: randomUUID(),
      tenant_id: input.tenantId,
      title: input.title,
      handle: input.handle,
      description: input.description ?? null,
      updated_at: new Date(),
    };
    // status is Generated<> (DB default 'draft'); pass it through only when given.
    if (input.status) values.status = input.status;
    if (input.kind) values.kind = input.kind;
    return db.insertInto('product').values(values).returningAll().executeTakeFirstOrThrow();
  },

  addOption(db: Kysely<CommerceDB>, input: AddOptionInput): Promise<CatalogOptionRow> {
    return db
      .insertInto('product_option')
      .values({
        id: randomUUID(),
        tenant_id: input.tenantId,
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
        tenant_id: input.tenantId,
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
        tenant_id: input.tenantId,
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
    tenantId: string,
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
        .where('tenant_id', '=', tenantId)
        .where('variant_id', '=', variantId)
        .execute();

      if (assignments.length > 0) {
        await trx
          .insertInto('product_variant_option')
          .values(
            assignments.map((assignment) => ({
              tenant_id: tenantId,
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
