-- Commerce engine: owned catalog (b4). Serial schema position: after b3
-- (guarded reservation), before b5 (pricing + tax). Adds the typed catalog:
-- product / product_option / product_option_value / product_variant + the
-- variant<->option matrix product_variant_option. Catalog CONTENT only: NO
-- price (b5), NO inventory linkage (b2/b3), NO Yjs (E5).
--
-- The two correctness-closing must-fixes that live at the database level:
--   1. the COMPOSITE FK on product_variant_option
--      (option_value_id, option_id) -> product_option_value(id, option_id),
--      whose target is the UNIQUE (id, option_id) index below. With it the
--      database REJECTS a variant option whose option_id does not match the
--      option_value's real option.
--   2. the option_signature BEFORE INSERT/UPDATE trigger that recomputes a
--      variant's signature by sorting its option_value_ids from
--      product_variant_option, plus a partial-UNIQUE on the signature so no two
--      LIVE variants of a product can share an option combination.
--
-- The dt_* tables (20260616000000_init) and the commerce ledger / reservation
-- objects (b2, b3) already exist; this migration only adds the catalog objects.
--
-- !!! TRIGGER-MAINTAINED-COLUMN DRIFT WARNING (read before `prisma migrate dev`) !!!
-- product_variant.option_signature is a raw-SQL TEXT column maintained by the
-- BEFORE INSERT/UPDATE trigger created near the bottom of this file. It is
-- INTENTIONALLY ABSENT from prisma/schema.prisma because Prisma has no datamodel
-- representation for a trigger-computed column. As a direct consequence the NEXT
-- `prisma migrate dev` will detect it as drift and PROPOSE a destructive
--   ALTER TABLE "commerce"."product_variant" DROP COLUMN "option_signature";
-- in the generated migration. That DROP MUST be deleted before applying: it would
-- remove the no-duplicate-combination guarantee and break the signature trigger.
-- The six partial-UNIQUE indexes below (handle, (product_id,title),
-- (option_id,value), sku, barcode, option_signature) are likewise raw SQL and
-- must not be dropped by a future generated migration.

-- CreateEnum
CREATE TYPE "commerce"."ProductStatus" AS ENUM ('draft', 'published');

-- CreateTable
CREATE TABLE "commerce"."product" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "description" TEXT,
    "status" "commerce"."ProductStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce"."product_option" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "product_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce"."product_option_value" (
    "id" TEXT NOT NULL,
    "option_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "product_option_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce"."product_variant" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "title" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce"."product_variant_option" (
    "variant_id" TEXT NOT NULL,
    "option_id" TEXT NOT NULL,
    "option_value_id" TEXT NOT NULL,

    CONSTRAINT "product_variant_option_pkey" PRIMARY KEY ("variant_id", "option_id")
);

-- CreateIndex
-- The composite-FK TARGET (must-fix 1). id alone is already the primary key; this
-- tuple-unique exists solely so (option_value_id, option_id) can reference it.
CREATE UNIQUE INDEX "product_option_value_id_option_id_key" ON "commerce"."product_option_value"("id", "option_id");

-- AddForeignKey
ALTER TABLE "commerce"."product_option" ADD CONSTRAINT "product_option_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "commerce"."product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."product_option_value" ADD CONSTRAINT "product_option_value_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "commerce"."product_option"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."product_variant" ADD CONSTRAINT "product_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "commerce"."product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."product_variant_option" ADD CONSTRAINT "product_variant_option_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "commerce"."product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- The COMPOSITE FK (must-fix 1): a variant option's (option_value_id, option_id)
-- must be a real (id, option_id) pair in product_option_value, so the database
-- rejects an option_value attached under the wrong option_id.
ALTER TABLE "commerce"."product_variant_option" ADD CONSTRAINT "product_variant_option_option_value_id_option_id_fkey" FOREIGN KEY ("option_value_id", "option_id") REFERENCES "commerce"."product_option_value"("id", "option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Raw-SQL additions (b4). The things Prisma cannot express natively: the
-- trigger-maintained option_signature column, the option_signature recompute
-- trigger, and the six partial-UNIQUE indexes (live-rows-only, so each frees on
-- soft-delete).
-- ===========================================================================

-- (A) option_signature: a TEXT column on product_variant, maintained EXCLUSIVELY
-- by the trigger below. Nullable on purpose: a variant with no option values yet
-- (e.g. a product's single default variant, or a freshly inserted variant before
-- setVariantOptions runs) has a NULL signature, and Postgres treats NULLs as
-- distinct in a UNIQUE index, so such variants never collide. Only a variant with
-- a real, non-empty option combination gets a non-NULL signature.
ALTER TABLE "commerce"."product_variant" ADD COLUMN "option_signature" TEXT;

-- (B) The signature recompute trigger (must-fix 2). BEFORE INSERT/UPDATE on
-- product_variant: it reads the variant's rows from product_variant_option and
-- sets NEW.option_signature to the option_value_ids sorted and joined, or NULL
-- when there are none. The trigger fires on the variant row, NOT on the matrix
-- table, so setVariantOptions must touch the variant row (a no-op UPDATE) after
-- changing the matrix to recompute the signature. Sorting makes the signature
-- order-independent: {Red, Small} and {Small, Red} produce the SAME signature, so
-- the partial-UNIQUE in (C) below rejects a second variant with the same
-- combination regardless of insertion order.
CREATE OR REPLACE FUNCTION "commerce"."compute_variant_option_signature"()
RETURNS TRIGGER AS $$
DECLARE
    sig TEXT;
BEGIN
    SELECT string_agg("option_value_id", ',' ORDER BY "option_value_id")
        INTO sig
        FROM "commerce"."product_variant_option"
        WHERE "variant_id" = NEW."id";
    -- string_agg over zero rows yields NULL; that is the intended "no combination
    -- yet" sentinel (NULLs are distinct under the partial-UNIQUE in (C)).
    NEW."option_signature" := sig;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_variant_option_signature"
    BEFORE INSERT OR UPDATE ON "commerce"."product_variant"
    FOR EACH ROW
    EXECUTE FUNCTION "commerce"."compute_variant_option_signature"();

-- (C) Partial-UNIQUE indexes (live rows only). Prisma cannot express partial
-- unique indexes, hence raw SQL. Each is UNIQUE only among rows with
-- deleted_at IS NULL, so the constrained value frees the moment a row is
-- soft-deleted and can be re-used.

-- product.handle: unique handle among live products.
CREATE UNIQUE INDEX "product_handle_active_key"
    ON "commerce"."product" ("handle")
    WHERE "deleted_at" IS NULL;

-- product_option (product_id, title): an option title is unique within a live
-- product.
CREATE UNIQUE INDEX "product_option_product_id_title_active_key"
    ON "commerce"."product_option" ("product_id", "title")
    WHERE "deleted_at" IS NULL;

-- product_option_value (option_id, value): a value is unique within a live option.
CREATE UNIQUE INDEX "product_option_value_option_id_value_active_key"
    ON "commerce"."product_option_value" ("option_id", "value")
    WHERE "deleted_at" IS NULL;

-- product_variant.sku: unique sku among live variants.
CREATE UNIQUE INDEX "product_variant_sku_active_key"
    ON "commerce"."product_variant" ("sku")
    WHERE "deleted_at" IS NULL;

-- product_variant.barcode: unique barcode among live variants.
CREATE UNIQUE INDEX "product_variant_barcode_active_key"
    ON "commerce"."product_variant" ("barcode")
    WHERE "deleted_at" IS NULL;

-- product_variant.option_signature (must-fix 2): no two LIVE variants can share
-- an option combination. option_value_ids are globally unique, so a non-NULL
-- signature is unique to one product's combination; NULL signatures (no
-- combination yet) are distinct and never collide. Live-rows-only so a
-- soft-deleted variant frees its combination for re-creation.
CREATE UNIQUE INDEX "product_variant_option_signature_active_key"
    ON "commerce"."product_variant" ("option_signature")
    WHERE "deleted_at" IS NULL;
