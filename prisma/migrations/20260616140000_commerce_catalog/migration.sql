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
--   2. the option_signature recompute triggers that derive a variant's signature
--      by sorting its option_value_ids from product_variant_option, plus a
--      partial-UNIQUE on the signature so no two LIVE variants of a product can
--      share an option combination. There are TWO triggers sharing one formula:
--      a BEFORE INSERT/UPDATE trigger on product_variant (for the bare-variant
--      case) AND an AFTER INSERT/UPDATE/DELETE trigger on product_variant_option
--      (the authoritative, matrix-derived recompute). The matrix-side trigger is
--      what makes no-duplicate-combination a DATABASE guarantee regardless of who
--      writes the matrix, not just an app promise.
--
-- The dt_* tables (20260616000000_init) and the commerce ledger / reservation
-- objects (b2, b3) already exist; this migration only adds the catalog objects.
--
-- !!! TRIGGER-MAINTAINED-COLUMN DRIFT WARNING (read before `prisma migrate dev`) !!!
-- product_variant.option_signature is a raw-SQL TEXT column maintained by TWO
-- triggers created near the bottom of this file: a BEFORE INSERT/UPDATE trigger on
-- product_variant (product_variant_option_signature) and an AFTER
-- INSERT/UPDATE/DELETE trigger on product_variant_option
-- (product_variant_option_signature_matrix). The column is INTENTIONALLY ABSENT
-- from prisma/schema.prisma because Prisma has no datamodel representation for a
-- trigger-computed column. As a direct consequence the NEXT `prisma migrate dev`
-- will detect it as drift and PROPOSE a destructive
--   ALTER TABLE "commerce"."product_variant" DROP COLUMN "option_signature";
-- in the generated migration. That DROP MUST be deleted before applying: it would
-- remove the no-duplicate-combination guarantee and break BOTH signature triggers.
-- Neither trigger appears in schema.prisma either; a future generated migration
-- must NOT drop product_variant_option_signature or
-- product_variant_option_signature_matrix.
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
-- rejects an option_value attached under the wrong option_id. ON UPDATE RESTRICT
-- (not CASCADE): product_option_value.id is an immutable uuid that is never
-- rewritten, so CASCADE buys nothing and is a latent stale-signature path (a
-- cascaded option_value_id change would shift the matrix without firing the
-- recompute through the normal write surface). RESTRICT keeps the id pinned.
ALTER TABLE "commerce"."product_variant_option" ADD CONSTRAINT "product_variant_option_option_value_id_option_id_fkey" FOREIGN KEY ("option_value_id", "option_id") REFERENCES "commerce"."product_option_value"("id", "option_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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

-- (B) The signature recompute (must-fix 1, the no-duplicate-combination guarantee)
-- is MATRIX-DERIVED: it is correct no matter who writes the matrix, because the
-- authoritative recompute fires on product_variant_option itself (trigger (B2)
-- below), not on the product_variant row. Both triggers share ONE formula: the
-- variant's option_value_ids from product_variant_option, sorted and comma-joined,
-- or NULL when there are none. Sorting makes the signature order-independent:
-- {Red, Small} and {Small, Red} produce the SAME signature, so the partial-UNIQUE
-- in (C) below rejects a second variant with the same combination regardless of
-- insertion order.
--
-- (B1) BEFORE INSERT/UPDATE on product_variant. This covers the bare-variant case:
-- a variant inserted (or row-updated) while it has no matrix rows yet still gets a
-- deterministic signature (NULL when empty) computed from its own id. Without it a
-- freshly inserted variant would carry whatever default the column has until a
-- matrix write happens. It recomputes from NEW.id, so it is also correct for a row
-- update that does not touch the matrix.
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

-- (B2) AFTER INSERT OR UPDATE OR DELETE on product_variant_option (the BLOCKER fix).
-- This is the authoritative recompute: ANY writer of the matrix (setVariantOptions,
-- a future matrix-only migration, a manual SQL edit, a realtime consumer) triggers
-- a fresh signature on the affected variant WITHOUT needing to also touch the
-- variant row. It UPDATEs product_variant.option_signature to the SAME sorted
-- string_agg formula as (B1), keyed on COALESCE(NEW.variant_id, OLD.variant_id)
-- (OLD covers DELETE, NEW covers INSERT/UPDATE). That UPDATE re-enters trigger (B1)
-- on the variant row, but (B1) recomputes the identical value, so the result is a
-- stable fixed point (no recursion: (B1) does not write the matrix). Because the
-- signature is now always in sync with the matrix, the partial-UNIQUE in (C)
-- enforces no-duplicate-combination as a true DATABASE guarantee, not an app
-- promise. This mirrors the b3 AFTER-trigger pattern on stock_movement.
CREATE OR REPLACE FUNCTION "commerce"."refresh_variant_option_signature"()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE "commerce"."product_variant"
        SET "option_signature" = (
            SELECT string_agg("option_value_id", ',' ORDER BY "option_value_id")
                FROM "commerce"."product_variant_option"
                WHERE "variant_id" = COALESCE(NEW."variant_id", OLD."variant_id")
        )
        WHERE "id" = COALESCE(NEW."variant_id", OLD."variant_id");
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_variant_option_signature_matrix"
    AFTER INSERT OR UPDATE OR DELETE ON "commerce"."product_variant_option"
    FOR EACH ROW
    EXECUTE FUNCTION "commerce"."refresh_variant_option_signature"();

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
