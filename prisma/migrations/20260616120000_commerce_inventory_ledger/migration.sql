-- Commerce engine: owned inventory ledger (b2). FIRST commerce schema writer.
--
-- Creates the `commerce` schema and the five inventory models, then applies the
-- four things Prisma cannot express in the datamodel and which make oversell
-- structurally impossible at the schema level:
--   1. the GENERATED STORED column inventory_level.available_quantity,
--   2. the CHECK (reserved_quantity <= stocked_quantity) backstop,
--   3. the partial-unique sku index (UNIQUE WHERE deleted_at IS NULL),
--   4. the append-only REVOKE UPDATE,DELETE ON stock_movement FROM commerce_app.
--
-- The dt_* tables already exist (20260616000000_init); this migration only adds
-- the commerce objects.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "commerce";

-- CreateEnum
CREATE TYPE "commerce"."StockMovementType" AS ENUM ('receive', 'reserve', 'release', 'fulfill', 'adjust', 'transfer');

-- CreateTable
CREATE TABLE "commerce"."inventory_item" (
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
);

-- CreateTable
CREATE TABLE "commerce"."stock_location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce"."inventory_level" (
    "id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "stocked_quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce"."stock_movement" (
    "id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "movement_type" "commerce"."StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "request_id" TEXT NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "transfer_group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce"."reservation" (
    "id" TEXT NOT NULL,
    "line_item_id" TEXT,
    "location_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_level_inventory_item_id_location_id_key" ON "commerce"."inventory_level"("inventory_item_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movement_request_id_key" ON "commerce"."stock_movement"("request_id");

-- CreateIndex
CREATE INDEX "stock_movement_inventory_item_id_location_id_idx" ON "commerce"."stock_movement"("inventory_item_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_request_id_key" ON "commerce"."reservation"("request_id");

-- AddForeignKey
ALTER TABLE "commerce"."inventory_level" ADD CONSTRAINT "inventory_level_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "commerce"."inventory_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."inventory_level" ADD CONSTRAINT "inventory_level_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "commerce"."stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."stock_movement" ADD CONSTRAINT "stock_movement_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "commerce"."inventory_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."stock_movement" ADD CONSTRAINT "stock_movement_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "commerce"."stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."reservation" ADD CONSTRAINT "reservation_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "commerce"."stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Raw-SQL additions (b2). The four things Prisma cannot express natively.
-- ===========================================================================

-- (1) Generated column: available_quantity = stocked_quantity - reserved_quantity,
-- STORED so it is DB-filterable and always consistent. GENERATED ALWAYS means it
-- can never be written by the application; it is recomputed on every write to the
-- two source columns. It is deliberately absent from the Prisma model.
ALTER TABLE "commerce"."inventory_level"
    ADD COLUMN "available_quantity" INTEGER NOT NULL
    GENERATED ALWAYS AS ("stocked_quantity" - "reserved_quantity") STORED;

-- (2) CHECK backstop: reserved can never exceed stocked. The guarded decrement
-- (b3) is the primary path; this is the database-level last line of defence so an
-- oversell is rejected even if application logic is bypassed.
ALTER TABLE "commerce"."inventory_level"
    ADD CONSTRAINT "inventory_level_reserved_lte_stocked_check"
    CHECK ("reserved_quantity" <= "stocked_quantity");

-- (3) Partial-unique sku: unique only among live rows (deleted_at IS NULL), so a
-- SKU frees the moment a row is soft-deleted and can be re-used. Prisma cannot
-- express partial unique indexes, hence raw SQL.
CREATE UNIQUE INDEX "inventory_item_sku_active_key"
    ON "commerce"."inventory_item" ("sku")
    WHERE "deleted_at" IS NULL;

-- (4) Append-only ledger: ordinary application traffic (commerce_app) may INSERT
-- and SELECT stock_movement but never UPDATE or DELETE, so the ledger is immutable
-- at the database (a table owner / superuser still can, which is why migrations
-- and corrections run as commerce_ddl, out of band). The REVOKE is guarded on role
-- existence so this migration also applies cleanly on a database where the roles
-- have not been provisioned yet (the roles are created out of band per
-- prisma/sql/commerce-roles.sql). Where commerce_app exists, the ledger becomes
-- append-only the moment this migration runs.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
        REVOKE UPDATE, DELETE ON "commerce"."stock_movement" FROM commerce_app;
    END IF;
END
$$;
