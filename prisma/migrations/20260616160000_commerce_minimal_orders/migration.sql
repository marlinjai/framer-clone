-- Commerce engine: minimal orders (b6). Serial schema position: LAST in the
-- commerce schema chain (after b5). Adds the Order + OrderLineItem models with
-- the full order-level German tax model, and FINALIZES the b5 CreditNote -> Order
-- hard FK (the corrected document is an Order/invoice).
--
-- Money is ALWAYS an integer in minor units (cents): every monetary column here
-- (order.subtotal/tax_amount/total, order_line_item.unit_price/subtotal/tax_amount)
-- is INTEGER, with the b5 non-negative money floor CHECK applied to each, so an
-- order total can never acquire a fractional/rounding error in the database.
-- tax_rate is integer BASIS POINTS (1900 = 19.00%). Totals are SERVER-COMPUTED in
-- createOrder, never client-trusted.
--
-- !!! DRIFT-EXCLUSION NOTE (read before regenerating this migration) !!!
-- As with b5, a `prisma migrate diff` against the cumulative schema PROPOSES the
-- destructive DROPs of the b2 generated column (inventory_level.available_quantity)
-- and the b4 trigger-maintained column (product_variant.option_signature), and the
-- ON UPDATE flip of the b4 composite FK. Those are DELIBERATELY EXCLUDED here too:
-- this migration contains ONLY the additive b6 objects below.

-- CreateEnum
CREATE TYPE "commerce"."OrderStatus" AS ENUM ('pending', 'confirmed', 'cancelled');

-- CreateEnum
CREATE TYPE "commerce"."CustomerType" AS ENUM ('b2c', 'b2b');

-- CreateEnum
CREATE TYPE "commerce"."NetOrGross" AS ENUM ('net', 'gross');

-- CreateEnum
CREATE TYPE "commerce"."VariantRefSource" AS ENUM ('none', 'datatable', 'owned');

-- CreateEnum
CREATE TYPE "commerce"."TaxTreatment" AS ENUM ('standard', 'reduced', 'zero', 'reverse_charge', 'kleinunternehmer');

-- CreateSequence: the monotonic, concurrency-safe source of order_number (a COUNT
-- would race two concurrent createOrder calls into the same number).
CREATE SEQUENCE "commerce"."order_number_seq";

-- AlterTable: finalize the b5 CreditNote -> Order hard FK. The column is added
-- here (b6 owns Order); the FK constraint is added in the AddForeignKey section.
ALTER TABLE "commerce"."credit_note" ADD COLUMN "order_id" TEXT;

-- CreateTable: order. Owns the order-level German tax model + server-computed
-- integer-cents totals. status defaults to 'confirmed' (stock reserved atomically).
CREATE TABLE "commerce"."order" (
    "id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "status" "commerce"."OrderStatus" NOT NULL DEFAULT 'confirmed',
    "currency_code" TEXT NOT NULL,
    "tax_region" TEXT NOT NULL,
    "vat_id" TEXT,
    "customer_type" "commerce"."CustomerType" NOT NULL DEFAULT 'b2c',
    "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
    "net_or_gross" "commerce"."NetOrGross" NOT NULL DEFAULT 'net',
    "kleinunternehmer" BOOLEAN NOT NULL DEFAULT false,
    "tax_note" TEXT,
    "subtotal" INTEGER NOT NULL,
    "tax_amount" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable: order_line_item. SNAPSHOT (not reference): the variant title/sku,
-- the resolved unit_price (cents), quantity, and the FULL tax treatment, copied at
-- creation. variant_ref/variant_ref_source is the loose carrier (NEVER medusa).
CREATE TABLE "commerce"."order_line_item" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "variant_title" TEXT,
    "variant_sku" TEXT,
    "unit_price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "tax_class" TEXT,
    "tax_rate" INTEGER NOT NULL,
    "tax_amount" INTEGER NOT NULL,
    "tax_treatment" "commerce"."TaxTreatment" NOT NULL,
    "variant_ref" TEXT,
    "variant_ref_source" "commerce"."VariantRefSource" NOT NULL DEFAULT 'none',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_order_number_key" ON "commerce"."order"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "order_request_id_key" ON "commerce"."order"("request_id");

-- CreateIndex
CREATE INDEX "order_line_item_order_id_idx" ON "commerce"."order_line_item"("order_id");

-- CreateIndex
CREATE INDEX "credit_note_order_id_idx" ON "commerce"."credit_note"("order_id");

-- AddForeignKey
ALTER TABLE "commerce"."order_line_item" ADD CONSTRAINT "order_line_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce"."order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: the FINALIZED b5 CreditNote -> Order FK. ON DELETE RESTRICT
-- encodes the no-DELETE-on-invoice contract: an Order a credit note corrects can
-- never be erased (the corrective document is the only legal correction path).
ALTER TABLE "commerce"."credit_note" ADD CONSTRAINT "credit_note_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce"."order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Raw-SQL CHECK constraints (b6): the b5 non-negative money floor, applied to
-- every order/line monetary column + the tax_rate basis-points floor. Prisma
-- cannot express CHECKs, so (like the b5 money floors) they live ONLY here and
-- are DELIBERATELY ABSENT from prisma/schema.prisma.
ALTER TABLE "commerce"."order" ADD CONSTRAINT "order_subtotal_nonneg_check" CHECK ("subtotal" >= 0);
ALTER TABLE "commerce"."order" ADD CONSTRAINT "order_tax_amount_nonneg_check" CHECK ("tax_amount" >= 0);
ALTER TABLE "commerce"."order" ADD CONSTRAINT "order_total_nonneg_check" CHECK ("total" >= 0);
ALTER TABLE "commerce"."order" ADD CONSTRAINT "order_currency_code_iso4217_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
-- The order total is the sum of its parts: a DB-enforced accounting identity so a
-- total can never drift from subtotal + tax_amount (server-computed in createOrder,
-- but the database is the last line of defence). Per the drift-exclusion note above,
-- Prisma cannot express this CHECK, so it lives ONLY here.
ALTER TABLE "commerce"."order" ADD CONSTRAINT "order_total_sum_check" CHECK ("total" = "subtotal" + "tax_amount");

ALTER TABLE "commerce"."order_line_item" ADD CONSTRAINT "order_line_item_unit_price_nonneg_check" CHECK ("unit_price" >= 0);
ALTER TABLE "commerce"."order_line_item" ADD CONSTRAINT "order_line_item_subtotal_nonneg_check" CHECK ("subtotal" >= 0);
ALTER TABLE "commerce"."order_line_item" ADD CONSTRAINT "order_line_item_tax_amount_nonneg_check" CHECK ("tax_amount" >= 0);
ALTER TABLE "commerce"."order_line_item" ADD CONSTRAINT "order_line_item_tax_rate_nonneg_check" CHECK ("tax_rate" >= 0);
-- tax_rate is integer BASIS POINTS, so a rate can never exceed 10000 (100%); an
-- explicit rate above the ceiling is rejected in createOrder AND backstopped here.
ALTER TABLE "commerce"."order_line_item" ADD CONSTRAINT "order_line_item_tax_rate_ceiling_check" CHECK ("tax_rate" <= 10000);
ALTER TABLE "commerce"."order_line_item" ADD CONSTRAINT "order_line_item_quantity_pos_check" CHECK ("quantity" > 0);

-- ===========================================================================
-- Raw-SQL addition (b6): the no-DELETE-on-invoice contract for orders.
--
-- A placed order is a German invoice: it can NEVER be UPDATEd or DELETEd by
-- ordinary application traffic; a mistake is corrected by issuing a CreditNote
-- that references it (b5), not by erasing it. This is the SAME append-only REVOKE
-- pattern b2 applied to stock_movement and b5 applied to credit_note. Guarded on
-- role existence so this migration also applies cleanly where the roles have not
-- been provisioned yet (roles are created out of band per prisma/sql/commerce-roles.sql).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
        REVOKE UPDATE, DELETE ON "commerce"."order" FROM commerce_app;
        REVOKE UPDATE, DELETE ON "commerce"."order_line_item" FROM commerce_app;
    END IF;
END
$$;
