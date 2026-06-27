import type { Migration } from '@marlinjai/tenant-db';

/**
 * CM-04 — `005_minimal_orders`: Order + OrderLineItem with the full order-level
 * German tax model, the per-schema order_number_seq, and the finalized
 * credit_note -> order hard FK. Ported 1:1 from
 * prisma/migrations/20260616160000_commerce_minimal_orders/migration.sql with the
 * `commerce.` qualification stripped (BARE names).
 *
 * Money is ALWAYS integer minor units (cents); tax_rate is integer BASIS POINTS
 * (1900 = 19.00%). Totals are server-computed; the DB CHECKs are the last line of
 * defence.
 *
 * The `order_number_seq` is now PER SCHEMA (one sequence per tg_<id>): order
 * numbers are monotonic within a tenant-group, which is correct.
 *
 * CHECK constraints reproduced per schema:
 *   - order.subtotal/tax_amount/total >= 0, currency_code ~ '^[A-Z]{3}$';
 *   - the accounting identity order.total = order.subtotal + order.tax_amount;
 *   - order_line_item.unit_price/subtotal/tax_amount/tax_rate >= 0,
 *     tax_rate <= 10000 (100%), quantity > 0.
 *
 * Append-only REVOKE UPDATE,DELETE on "order" + order_line_item (a placed order
 * is an immutable German invoice; see the CM-04 completion note on grant order).
 *
 * The 5 order enums (OrderStatus, CustomerType, NetOrGross, VariantRefSource,
 * TaxTreatment) are created in `000_enums`. `order` is a reserved word and stays
 * double-quoted throughout.
 */
export const minimalOrders: Migration = {
  id: '005_minimal_orders',
  up: async (tx) => {
    // CreateSequence: the monotonic, concurrency-safe source of order_number.
    await tx`CREATE SEQUENCE IF NOT EXISTS "order_number_seq"`;

    // AlterTable: finalize the credit_note -> order hard FK (column added here;
    // FK constraint added below).
    await tx`ALTER TABLE "credit_note" ADD COLUMN IF NOT EXISTS "order_id" TEXT`;

    // CreateTable: order. Owns the order-level German tax model + server-computed
    // integer-cents totals. status defaults to 'confirmed'.
    await tx`
      CREATE TABLE IF NOT EXISTS "order" (
        "id" TEXT NOT NULL,
        "order_number" TEXT NOT NULL,
        "request_id" TEXT NOT NULL,
        "status" "OrderStatus" NOT NULL DEFAULT 'confirmed',
        "currency_code" TEXT NOT NULL,
        "tax_region" TEXT NOT NULL,
        "vat_id" TEXT,
        "customer_type" "CustomerType" NOT NULL DEFAULT 'b2c',
        "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
        "net_or_gross" "NetOrGross" NOT NULL DEFAULT 'net',
        "kleinunternehmer" BOOLEAN NOT NULL DEFAULT false,
        "tax_note" TEXT,
        "subtotal" INTEGER NOT NULL,
        "tax_amount" INTEGER NOT NULL,
        "total" INTEGER NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "order_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable: order_line_item. SNAPSHOT of the variant + full tax treatment.
    await tx`
      CREATE TABLE IF NOT EXISTS "order_line_item" (
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
        "tax_treatment" "TaxTreatment" NOT NULL,
        "variant_ref" TEXT,
        "variant_ref_source" "VariantRefSource" NOT NULL DEFAULT 'none',
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "order_line_item_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateIndex
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "order_order_number_key" ON "order"("order_number")`;
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "order_request_id_key" ON "order"("request_id")`;
    await tx`CREATE INDEX IF NOT EXISTS "order_line_item_order_id_idx" ON "order_line_item"("order_id")`;
    await tx`CREATE INDEX IF NOT EXISTS "credit_note_order_id_idx" ON "credit_note"("order_id")`;

    // AddForeignKey
    await tx`ALTER TABLE "order_line_item" ADD CONSTRAINT "order_line_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE`;
    // The finalized credit_note -> order FK. ON DELETE RESTRICT: an order a credit
    // note corrects can never be erased.
    await tx`ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE`;

    // ====================================================================
    // Raw-SQL CHECK constraints: money floor on every order/line column, the
    // accounting identity, and the tax_rate basis-points band.
    // ====================================================================
    await tx`ALTER TABLE "order" ADD CONSTRAINT "order_subtotal_nonneg_check" CHECK ("subtotal" >= 0)`;
    await tx`ALTER TABLE "order" ADD CONSTRAINT "order_tax_amount_nonneg_check" CHECK ("tax_amount" >= 0)`;
    await tx`ALTER TABLE "order" ADD CONSTRAINT "order_total_nonneg_check" CHECK ("total" >= 0)`;
    await tx`ALTER TABLE "order" ADD CONSTRAINT "order_currency_code_iso4217_check" CHECK ("currency_code" ~ '^[A-Z]{3}$')`;
    // The order total is the sum of its parts: a DB-enforced accounting identity.
    await tx`ALTER TABLE "order" ADD CONSTRAINT "order_total_sum_check" CHECK ("total" = "subtotal" + "tax_amount")`;

    await tx`ALTER TABLE "order_line_item" ADD CONSTRAINT "order_line_item_unit_price_nonneg_check" CHECK ("unit_price" >= 0)`;
    await tx`ALTER TABLE "order_line_item" ADD CONSTRAINT "order_line_item_subtotal_nonneg_check" CHECK ("subtotal" >= 0)`;
    await tx`ALTER TABLE "order_line_item" ADD CONSTRAINT "order_line_item_tax_amount_nonneg_check" CHECK ("tax_amount" >= 0)`;
    await tx`ALTER TABLE "order_line_item" ADD CONSTRAINT "order_line_item_tax_rate_nonneg_check" CHECK ("tax_rate" >= 0)`;
    // tax_rate is integer BASIS POINTS, so a rate can never exceed 10000 (100%).
    await tx`ALTER TABLE "order_line_item" ADD CONSTRAINT "order_line_item_tax_rate_ceiling_check" CHECK ("tax_rate" <= 10000)`;
    await tx`ALTER TABLE "order_line_item" ADD CONSTRAINT "order_line_item_quantity_pos_check" CHECK ("quantity" > 0)`;

    // ====================================================================
    // Append-only REVOKE: a placed order is a German invoice. Guarded on role
    // existence.
    // ====================================================================
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE UPDATE, DELETE ON "order" FROM commerce_app;
          REVOKE UPDATE, DELETE ON "order_line_item" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
