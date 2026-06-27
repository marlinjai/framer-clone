import type { Migration } from '@marlinjai/tenant-db';

/**
 * CM-04 — `002_guarded_reservation`: reservation support + the deferred
 * transfer-balance constraint. Ported 1:1 from
 * prisma/migrations/20260616130000_commerce_guarded_reservation/migration.sql
 * (the fulfillment_location_default table + the transfer trigger) PLUS the
 * `reservation` table/index/FK, which the source created in the inventory-ledger
 * migration; the plan §4.2 groups it here. Migration-boundary placement only —
 * the end-state schema is byte-identical.
 *
 * BARE table names (runner injects `SET LOCAL search_path = <tg_id>, ext`).
 *
 * The DEFERRED CONSTRAINT TRIGGER asserts a transfer group is exactly two
 * stock_movement rows summing to zero, checked at COMMIT (DEFERRABLE INITIALLY
 * DEFERRED) so the two halves may be inserted in either order.
 *
 * CRITICAL per-tenant adaptation: the trigger FUNCTION body references
 * `stock_movement` by BARE name, but a trigger function resolves object names at
 * FIRE time using the CALLING session's search_path — and the app role's default
 * is `ext` (not the tenant schema). So the function is created
 * `SET search_path FROM CURRENT`: at migration time CURRENT is the injected
 * `<tg_id>, ext`, which is captured into the function's config and used on every
 * future invocation. This makes the bare names resolve to THIS schema at
 * fire-time without hardcoding the schema name in the body.
 */
export const guardedReservation: Migration = {
  id: '002_guarded_reservation',
  up: async (tx) => {
    // CreateTable: reservation (FK target stock_location exists from 001).
    await tx`
      CREATE TABLE IF NOT EXISTS "reservation" (
        "id" TEXT NOT NULL,
        "line_item_id" TEXT,
        "location_id" TEXT NOT NULL,
        "quantity" INTEGER NOT NULL,
        "request_id" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "reservation_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateIndex
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "reservation_request_id_key" ON "reservation"("request_id")`;

    // AddForeignKey
    await tx`ALTER TABLE "reservation" ADD CONSTRAINT "reservation_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE`;

    // CreateTable: per-workspace default fulfillment location config.
    await tx`
      CREATE TABLE IF NOT EXISTS "fulfillment_location_default" (
        "workspace_id" TEXT NOT NULL,
        "location_id" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "fulfillment_location_default_pkey" PRIMARY KEY ("workspace_id")
      )
    `;

    // AddForeignKey
    await tx`ALTER TABLE "fulfillment_location_default" ADD CONSTRAINT "fulfillment_location_default_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE`;

    // ====================================================================
    // Deferred transfer-balance trigger. A transfer is two 'transfer'
    // stock_movement rows sharing one transfer_group_id, one negative and one
    // positive, summing to zero. DEFERRED to commit so both halves can be
    // inserted in either order; at commit the group must be whole and balanced.
    // ====================================================================
    await tx`
      CREATE OR REPLACE FUNCTION "assert_transfer_group_balanced"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          group_total BIGINT;
          group_count INTEGER;
      BEGIN
          -- Non-transfer movements (no group) are unaffected: fast exit.
          IF NEW."transfer_group_id" IS NULL THEN
              RETURN NEW;
          END IF;

          SELECT COALESCE(SUM("quantity"), 0), COUNT(*)
              INTO group_total, group_count
              FROM "stock_movement"
              WHERE "transfer_group_id" = NEW."transfer_group_id";

          -- A balanced transfer is exactly two halves summing to zero. Anything
          -- else (a lone half, three rows, a non-zero sum) is rejected at commit.
          IF group_count <> 2 OR group_total <> 0 THEN
              RAISE EXCEPTION
                  'transfer group % is unbalanced: % rows summing to % (expected exactly 2 rows summing to 0)',
                  NEW."transfer_group_id", group_count, group_total
                  USING ERRCODE = 'check_violation';
          END IF;

          RETURN NEW;
      END;
      $$
    `;

    await tx`DROP TRIGGER IF EXISTS "stock_movement_transfer_balance" ON "stock_movement"`;
    await tx`
      CREATE CONSTRAINT TRIGGER "stock_movement_transfer_balance"
          AFTER INSERT ON "stock_movement"
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          EXECUTE FUNCTION "assert_transfer_group_balanced"()
    `;
  },
};
