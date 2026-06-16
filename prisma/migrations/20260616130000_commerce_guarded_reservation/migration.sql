-- Commerce engine: guarded reservation support (b3). Serial schema position:
-- after b2 (inventory ledger), before b4 (catalog). This migration adds the two
-- things b3 needs that live at the database level and that Prisma cannot express
-- in the datamodel:
--
--   1. the per-workspace default-fulfillment-location config table
--      (commerce.fulfillment_location_default), which resolveLocation reads when
--      a reservation omits an explicit locationId. It is a plain table and IS
--      represented in prisma/schema.prisma (model FulfillmentLocationDefault), so
--      it does not drift; the CREATE TABLE / FK below mirror that model exactly.
--
--   2. the DEFERRED transfer-balance CONSTRAINT TRIGGER on stock_movement. Paired
--      transfer movements share a transfer_group_id; the trigger fires at COMMIT
--      (DEFERRABLE INITIALLY DEFERRED) and asserts the group has exactly two
--      halves whose quantities sum to zero. A half-completed transfer (one row
--      inserted, its mirror missing) therefore cannot commit. Prisma has no
--      datamodel representation for a CONSTRAINT TRIGGER, so it is raw SQL and is
--      INTENTIONALLY ABSENT from schema.prisma. As with the b2 generated column /
--      CHECK constraints, a later `prisma migrate dev` may not see the trigger
--      and must NOT be allowed to drop it.
--
-- The guarded conditional decrement itself (the oversell lock) is application
-- code (src/server/commerce/inventory/reserve.ts) running a guarded
-- UPDATE ... WHERE available >= needed inside a READ COMMITTED transaction; it
-- needs no schema object beyond what b2 already shipped (the row write-lock, the
-- reserved <= stocked CHECK backstop, and the UNIQUE(request_id) idempotency
-- guard all come from b2).

-- CreateTable
CREATE TABLE "commerce"."fulfillment_location_default" (
    "workspace_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fulfillment_location_default_pkey" PRIMARY KEY ("workspace_id")
);

-- AddForeignKey
ALTER TABLE "commerce"."fulfillment_location_default" ADD CONSTRAINT "fulfillment_location_default_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "commerce"."stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Deferred transfer-balance trigger (b3). Raw SQL; Prisma cannot express a
-- CONSTRAINT TRIGGER. A transfer is two stock_movement rows of type 'transfer'
-- sharing one transfer_group_id: one negative quantity (out of the source
-- location) and one positive (into the destination), so the pair sums to zero.
-- The check is DEFERRED to commit so the two halves can be inserted in either
-- order within one transaction; at commit the group must be whole and balanced.
-- ===========================================================================

CREATE OR REPLACE FUNCTION "commerce"."assert_transfer_group_balanced"()
RETURNS TRIGGER AS $$
DECLARE
    group_total BIGINT;
    group_count INTEGER;
BEGIN
    -- Non-transfer movements (no group) are unaffected: fast exit, no overhead.
    IF NEW."transfer_group_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(SUM("quantity"), 0), COUNT(*)
        INTO group_total, group_count
        FROM "commerce"."stock_movement"
        WHERE "transfer_group_id" = NEW."transfer_group_id";

    -- A balanced transfer is exactly two halves summing to zero. Anything else
    -- (a lone half, three rows, a non-zero sum) is rejected at commit, so a
    -- half-completed transfer can never persist.
    IF group_count <> 2 OR group_total <> 0 THEN
        RAISE EXCEPTION
            'transfer group % is unbalanced: % rows summing to % (expected exactly 2 rows summing to 0)',
            NEW."transfer_group_id", group_count, group_total
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "stock_movement_transfer_balance"
    AFTER INSERT ON "commerce"."stock_movement"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "commerce"."assert_transfer_group_balanced"();
