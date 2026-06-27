import type { Migration } from '@marlinjai/tenant-db';

/**
 * CM-04 — `001_inventory_ledger`: the owned inventory ledger, ported 1:1 from
 * prisma/migrations/20260616120000_commerce_inventory_ledger/migration.sql with
 * the `commerce.` schema qualification stripped (the runner injects
 * `SET LOCAL search_path = <tg_id>, ext`, so bodies use BARE names).
 *
 * Structural guarantees Prisma cannot express, reproduced PER SCHEMA:
 *   1. inventory_level.available_quantity GENERATED ALWAYS ... STORED,
 *   2. CHECK reserved_quantity <= stocked_quantity (oversell backstop),
 *   3. non-negativity floors stocked_quantity >= 0, reserved_quantity >= 0,
 *   4. partial-unique inventory_item_sku_active_key WHERE deleted_at IS NULL,
 *   5. append-only REVOKE UPDATE,DELETE ON stock_movement FROM commerce_app.
 *
 * Faithful-port notes (matches today's `commerce` schema byte-for-byte):
 *   - ids are TEXT with NO DB default (Prisma generated uuid() at the app layer);
 *   - updated_at is NOT NULL with NO default and NO trigger (Prisma's @updatedAt
 *     set it at the app layer). We do NOT add ext.gen_uuid_v7()/touch_updated_at()
 *     here: adding them would make tg_<id> structurally DIFFER from `commerce`.
 *   - The StockMovementType enum is created in `000_enums` (must precede this).
 *   - The `reservation` table + its index/FK live in `002_guarded_reservation`
 *     per the plan §4.2 (the source migration created `reservation` here; this is
 *     a migration-boundary placement only — the end-state schema is identical).
 */
export const inventoryLedger: Migration = {
  id: '001_inventory_ledger',
  up: async (tx) => {
    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "inventory_item" (
        "id" TEXT NOT NULL,
        "sku" TEXT NOT NULL,
        "title" TEXT,
        "length_mm" INTEGER,
        "width_mm" INTEGER,
        "height_mm" INTEGER,
        "weight_g" INTEGER,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        "deleted_at" TIMESTAMP(3),

        CONSTRAINT "inventory_item_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "stock_location" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "stock_location_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "inventory_level" (
        "id" TEXT NOT NULL,
        "inventory_item_id" TEXT NOT NULL,
        "location_id" TEXT NOT NULL,
        "stocked_quantity" INTEGER NOT NULL DEFAULT 0,
        "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
        "version" INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "inventory_level_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "stock_movement" (
        "id" TEXT NOT NULL,
        "inventory_item_id" TEXT NOT NULL,
        "location_id" TEXT NOT NULL,
        "movement_type" "StockMovementType" NOT NULL,
        "quantity" INTEGER NOT NULL,
        "request_id" TEXT NOT NULL,
        "ref_type" TEXT,
        "ref_id" TEXT,
        "transfer_group_id" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateIndex
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "inventory_level_inventory_item_id_location_id_key" ON "inventory_level"("inventory_item_id", "location_id")`;
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "stock_movement_request_id_key" ON "stock_movement"("request_id")`;
    await tx`CREATE INDEX IF NOT EXISTS "stock_movement_inventory_item_id_location_id_idx" ON "stock_movement"("inventory_item_id", "location_id")`;

    // AddForeignKey
    await tx`ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE`;
    await tx`ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE`;
    await tx`ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE`;
    await tx`ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE`;

    // ====================================================================
    // Raw-SQL additions: the things Prisma cannot express natively.
    // ====================================================================

    // (1) GENERATED STORED available_quantity = stocked - reserved. GENERATED
    // ALWAYS so the application can never write it; recomputed on every write to
    // the two source columns. DB-filterable and always consistent.
    await tx`
      ALTER TABLE "inventory_level"
        ADD COLUMN IF NOT EXISTS "available_quantity" INTEGER NOT NULL
        GENERATED ALWAYS AS ("stocked_quantity" - "reserved_quantity") STORED
    `;

    // (2) CHECK backstop: reserved can never exceed stocked (oversell guard).
    await tx`
      ALTER TABLE "inventory_level"
        ADD CONSTRAINT "inventory_level_reserved_lte_stocked_check"
        CHECK ("reserved_quantity" <= "stocked_quantity")
    `;

    // (2b) Non-negativity floors so a negative pair cannot mint phantom stock.
    // Combined with (2) the reachable region is 0 <= reserved <= stocked, so
    // available_quantity is always in [0, stocked].
    await tx`
      ALTER TABLE "inventory_level"
        ADD CONSTRAINT "inventory_level_stocked_nonneg_check"
        CHECK ("stocked_quantity" >= 0)
    `;
    await tx`
      ALTER TABLE "inventory_level"
        ADD CONSTRAINT "inventory_level_reserved_nonneg_check"
        CHECK ("reserved_quantity" >= 0)
    `;

    // (4) Partial-unique sku: unique only among live rows (deleted_at IS NULL),
    // so a SKU frees the moment a row is soft-deleted and can be re-used.
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "inventory_item_sku_active_key"
        ON "inventory_item" ("sku")
        WHERE "deleted_at" IS NULL
    `;

    // (5) Append-only ledger: commerce_app may INSERT/SELECT stock_movement but
    // never UPDATE/DELETE. Guarded on role existence so it applies cleanly even
    // before the role is provisioned. (The runner GRANTs ALL to the app role
    // AFTER migrations run, so a deploy/onboard step must re-apply this REVOKE
    // post-grant for it to bite — see CM-04 completion notes.)
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE UPDATE, DELETE ON "stock_movement" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
