import type { Migration } from '@marlinjai/tenant-db';

/**
 * CM-04 — `000_enums`: the 9 commerce enum TYPES, created FIRST so every table in
 * `001`..`005` that references one already has its type.
 *
 * Postgres enums are SCHEMA-SCOPED types, so each `tg_<id>` schema gets its own
 * copy (bare names under the runner-injected `SET LOCAL search_path = <schema>,
 * ext`). This keeps every per-tenant schema self-contained: `pg_dump -n tg_x`
 * carries the enum definitions too.
 *
 * Value sets are ported VERBATIM from the source commerce migration SQL
 * (prisma/migrations/2026061612.. / 14.. / 15.. / 16..). Do not invent values.
 *
 * Type names keep their double quotes because they are MixedCase: unquoted,
 * Postgres would fold `StockMovementType` to `stockmovementtype` and the column
 * type references in later migrations (also quoted, MixedCase) would not match.
 *
 * Idempotency: the runner tracks applied ids in each schema's
 * `__tenant_db_migrations`, so this body runs exactly once per schema (CREATE
 * TYPE has no IF NOT EXISTS form; the runner's per-schema tracking is the guard).
 */
export const enums: Migration = {
  id: '000_enums',
  up: async (tx) => {
    // 001 (inventory ledger): stock_movement.movement_type
    await tx`CREATE TYPE "StockMovementType" AS ENUM ('receive', 'reserve', 'release', 'fulfill', 'adjust', 'transfer')`;

    // 003 (catalog): product.status
    await tx`CREATE TYPE "ProductStatus" AS ENUM ('draft', 'published')`;

    // 004 (pricing + tax): price_list.status / price_list.type
    await tx`CREATE TYPE "PriceListStatus" AS ENUM ('draft', 'active')`;
    await tx`CREATE TYPE "PriceListType" AS ENUM ('override', 'sale')`;

    // 005 (minimal orders): order.status / order.customer_type / order.net_or_gross
    // and order_line_item.variant_ref_source / order_line_item.tax_treatment
    await tx`CREATE TYPE "OrderStatus" AS ENUM ('pending', 'confirmed', 'cancelled')`;
    await tx`CREATE TYPE "CustomerType" AS ENUM ('b2c', 'b2b')`;
    await tx`CREATE TYPE "NetOrGross" AS ENUM ('net', 'gross')`;
    await tx`CREATE TYPE "VariantRefSource" AS ENUM ('none', 'datatable', 'owned')`;
    await tx`CREATE TYPE "TaxTreatment" AS ENUM ('standard', 'reduced', 'zero', 'reverse_charge', 'kleinunternehmer')`;
  },
};
