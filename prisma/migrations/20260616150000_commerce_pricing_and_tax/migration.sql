-- Commerce engine: pricing graph + catalog-side tax_class + corrective-invoice
-- entity (b5). Serial schema position: after b4 (catalog), before b6 (orders).
-- Adds the pricing graph (price_set / price / price_rule / price_list), the
-- CATALOG-side tax_class column on product and product_variant, and the
-- CreditNote (Storno / Gutschrift) + credit_note_ref corrective-invoice entity.
--
-- Money is ALWAYS an integer in minor units (cents): every monetary column here
-- (price.amount, credit_note.amount) is INTEGER, so a price can never acquire a
-- fractional/rounding error in the database. The resolver reads these rows and
-- returns integer cents unchanged (no float math on the path).
--
-- b5 owns ONLY the pricing graph, the catalog-side tax_class, and the
-- CreditNote entity. It adds NO Order.* fields and creates NO Order model: the
-- order-level tax fields (tax_region / vat_id / customer_type / reverse_charge /
-- net_or_gross / kleinunternehmer) and the Order model itself are OWNED by b6.
-- The bought tax-engine call, OSS accumulation, and invoice rendering are E8.
--
-- !!! DRIFT-EXCLUSION NOTE (read before regenerating this migration) !!!
-- `prisma migrate diff` against the cumulative schema PROPOSES three destructive
-- statements that are DELIBERATELY EXCLUDED from this migration, because they
-- would undo the b2 and b4 database-level guarantees that are intentionally
-- absent from prisma/schema.prisma (Prisma cannot express them):
--   1. ALTER TABLE "commerce"."inventory_level" DROP COLUMN "available_quantity";
--      (b2's GENERATED STORED oversell-guard column). EXCLUDED.
--   2. ALTER TABLE "commerce"."product_variant" DROP COLUMN "option_signature";
--      (b4's trigger-maintained no-duplicate-combination column). EXCLUDED; only
--      the ADD COLUMN "tax_class" half of that AlterTable is kept.
--   3. DROP + re-ADD of product_variant_option_option_value_id_option_id_fkey to
--      flip it from ON UPDATE RESTRICT (b4's deliberate choice, see the b4
--      migration) back to Prisma's default ON UPDATE CASCADE. EXCLUDED: b4 pinned
--      RESTRICT on purpose so a cascaded option_value_id change cannot shift the
--      matrix without firing the signature recompute.
-- This migration therefore contains ONLY the additive b5 objects below.

-- CreateEnum
CREATE TYPE "commerce"."PriceListStatus" AS ENUM ('draft', 'active');

-- CreateEnum
CREATE TYPE "commerce"."PriceListType" AS ENUM ('override', 'sale');

-- AlterTable: catalog-side tax_class (the ONLY tax surface b5 owns). A
-- classification string mapping to a future bought tax engine's product-tax-code,
-- NOT a rate and NOT an Order-level tax field.
ALTER TABLE "commerce"."product" ADD COLUMN "tax_class" TEXT;

-- AlterTable: per-variant tax_class override (NULL falls back to the product's).
-- NOTE: the option_signature column is NOT dropped here (see the drift-exclusion
-- note above); only this ADD COLUMN is applied.
ALTER TABLE "commerce"."product_variant" ADD COLUMN "tax_class" TEXT;

-- CreateTable: price_set (pset). Exactly one per variant (variant_id UNIQUE,
-- nullable so a set can be staged before attachment).
CREATE TABLE "commerce"."price_set" (
    "id" TEXT NOT NULL,
    "variant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_set_pkey" PRIMARY KEY ("id")
);

-- CreateTable: price. amount is INTEGER minor units (cents), never a float.
-- Belongs to a price_set and OPTIONALLY a price_list (NULL = base price).
CREATE TABLE "commerce"."price" (
    "id" TEXT NOT NULL,
    "price_set_id" TEXT NOT NULL,
    "price_list_id" TEXT,
    "currency_code" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "min_quantity" INTEGER,
    "max_quantity" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_pkey" PRIMARY KEY ("id")
);

-- CreateTable: price_rule (prule). attribute / value / operator with a priority.
CREATE TABLE "commerce"."price_rule" (
    "id" TEXT NOT NULL,
    "price_id" TEXT NOT NULL,
    "attribute" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'eq',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable: price_list (plist). status enum + type + optional active window.
CREATE TABLE "commerce"."price_list" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "status" "commerce"."PriceListStatus" NOT NULL DEFAULT 'draft',
    "type" "commerce"."PriceListType" NOT NULL DEFAULT 'override',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable: credit_note (Storno / Gutschrift). amount INTEGER (cents).
-- corrected_ref is a LOOSE reference to the corrected Order/invoice; the hard FK
-- is deferred to b6 (which owns Order).
CREATE TABLE "commerce"."credit_note" (
    "id" TEXT NOT NULL,
    "corrected_ref" TEXT,
    "reason" TEXT,
    "currency_code" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable: credit_note_ref. The junction tying a credit note to the
-- document(s) it corrects via a loose (ref_type, ref_id) pair (b6 finalizes the
-- FK to Order).
CREATE TABLE "commerce"."credit_note_ref" (
    "id" TEXT NOT NULL,
    "credit_note_id" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_ref_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "price_set_variant_id_key" ON "commerce"."price_set"("variant_id");

-- CreateIndex
CREATE INDEX "price_price_set_id_currency_code_idx" ON "commerce"."price"("price_set_id", "currency_code");

-- CreateIndex
CREATE INDEX "price_rule_price_id_idx" ON "commerce"."price_rule"("price_id");

-- CreateIndex
CREATE INDEX "credit_note_ref_ref_type_ref_id_idx" ON "commerce"."credit_note_ref"("ref_type", "ref_id");

-- AddForeignKey
ALTER TABLE "commerce"."price_set" ADD CONSTRAINT "price_set_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "commerce"."product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."price" ADD CONSTRAINT "price_price_set_id_fkey" FOREIGN KEY ("price_set_id") REFERENCES "commerce"."price_set"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."price" ADD CONSTRAINT "price_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "commerce"."price_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."price_rule" ADD CONSTRAINT "price_rule_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "commerce"."price"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce"."credit_note_ref" ADD CONSTRAINT "credit_note_ref_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "commerce"."credit_note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Raw-SQL CHECK constraints (b5): money + quantity-band + currency-code sanity.
--
-- These belong in the SAME drift-exclusion family as the b2/b4 database-level
-- guarantees above: Prisma cannot express a CHECK constraint, so they live ONLY
-- in this migration and are DELIBERATELY ABSENT from prisma/schema.prisma. A
-- `prisma migrate diff` will NOT propose them and MUST NOT be used to "reconcile"
-- them away (they are intentional, like the GENERATED column and the trigger).
--
-- MUST-FIX 1 (money floor): a money column with no non-negativity floor lets a
-- negative price.amount insert cleanly, and resolvePrice then selects it as the
-- lowest-amount winner (a money-losing price). The CHECK rejects it loudly at the
-- database, the mirror of the assertIntegerCents tightening in pricing.ts.
ALTER TABLE "commerce"."price" ADD CONSTRAINT "price_amount_nonneg_check" CHECK ("amount" >= 0);
ALTER TABLE "commerce"."credit_note" ADD CONSTRAINT "credit_note_amount_nonneg_check" CHECK ("amount" >= 0);

-- MS-2 (quantity-band sanity): a band must be non-negative and not inverted. An
-- inverted band (min_quantity > max_quantity) can never match any quantity, so it
-- would silently drop a price from resolution; reject it loudly instead. NULL on
-- either side (unbounded) passes the comparison (NULL CHECK is treated as TRUE).
ALTER TABLE "commerce"."price" ADD CONSTRAINT "price_min_quantity_nonneg_check" CHECK ("min_quantity" >= 0);
ALTER TABLE "commerce"."price" ADD CONSTRAINT "price_max_quantity_nonneg_check" CHECK ("max_quantity" >= 0);
ALTER TABLE "commerce"."price" ADD CONSTRAINT "price_quantity_band_check" CHECK ("min_quantity" <= "max_quantity");

-- MS-3 (currency-code shape): currency_code must be an ISO-4217 alpha-3 code in
-- UPPERCASE. Without this a mis-cased 'eur' inserts cleanly and then silently
-- resolves to NO price (resolvePrice filters on an exact currencyCode match), so
-- the band-sanity / money-floor guarantees would be moot for that row. Reject the
-- mis-cased / mis-shaped code at the database.
ALTER TABLE "commerce"."price" ADD CONSTRAINT "price_currency_code_iso4217_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "commerce"."credit_note" ADD CONSTRAINT "credit_note_currency_code_iso4217_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');

-- ===========================================================================
-- Raw-SQL addition (b5): the no-DELETE-on-invoice contract.
--
-- A German invoice (and its corrective credit note) can NEVER be DELETEd or
-- altered: a mistake is corrected by issuing a new credit_note that REFERENCES
-- the corrected document, not by erasing or editing the record. The corrected
-- document (Order/invoice) is owned by b6, so b6 will apply the same REVOKE to
-- the order/invoice tables it creates; b5 applies it here to credit_note and
-- credit_note_ref, which are themselves permanent accounting records. This is
-- the SAME append-only pattern b2 applied to stock_movement: ordinary
-- application traffic (commerce_app) may INSERT and SELECT but never UPDATE or
-- DELETE, so the records are immutable at the database (a table owner /
-- superuser still can, which is why corrections run as commerce_ddl out of
-- band). The REVOKE is guarded on role existence so this migration also applies
-- cleanly on a database where the roles have not been provisioned yet (roles are
-- created out of band per prisma/sql/commerce-roles.sql).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
        REVOKE UPDATE, DELETE ON "commerce"."credit_note" FROM commerce_app;
        REVOKE UPDATE, DELETE ON "commerce"."credit_note_ref" FROM commerce_app;
    END IF;
END
$$;
