import type { Migration } from '@marlinjai/tenant-db';

/**
 * CM-04 — `004_pricing_and_tax`: the pricing graph (price_set / price /
 * price_rule / price_list), the catalog-side tax_class columns, and the
 * credit_note (Storno / Gutschrift) + credit_note_ref corrective-invoice entity.
 * Ported 1:1 from
 * prisma/migrations/20260616150000_commerce_pricing_and_tax/migration.sql with
 * the `commerce.` qualification stripped (BARE names).
 *
 * Money is ALWAYS integer minor units (cents): every monetary column is INTEGER.
 *
 * CHECK constraints reproduced per schema:
 *   - price.amount >= 0, credit_note.amount >= 0 (money floors);
 *   - price.min_quantity >= 0, price.max_quantity >= 0, min <= max (band sanity);
 *   - price.currency_code / credit_note.currency_code ~ '^[A-Z]{3}$' (ISO-4217).
 *
 * Append-only REVOKE UPDATE,DELETE on credit_note + credit_note_ref (the
 * no-DELETE-on-invoice contract; see the CM-04 completion note on grant order).
 *
 * PriceListStatus / PriceListType enums are created in `000_enums`.
 */
export const pricingAndTax: Migration = {
  id: '004_pricing_and_tax',
  up: async (tx) => {
    // AlterTable: catalog-side tax_class (a classification string, NOT a rate).
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "tax_class" TEXT`;
    // AlterTable: per-variant tax_class override (NULL falls back to product's).
    await tx`ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "tax_class" TEXT`;

    // CreateTable: price_set (exactly one per variant; variant_id UNIQUE, nullable
    // so a set can be staged before attachment).
    await tx`
      CREATE TABLE IF NOT EXISTS "price_set" (
        "id" TEXT NOT NULL,
        "variant_id" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "price_set_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable: price. amount is INTEGER minor units (cents).
    await tx`
      CREATE TABLE IF NOT EXISTS "price" (
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
      )
    `;

    // CreateTable: price_rule.
    await tx`
      CREATE TABLE IF NOT EXISTS "price_rule" (
        "id" TEXT NOT NULL,
        "price_id" TEXT NOT NULL,
        "attribute" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "operator" TEXT NOT NULL DEFAULT 'eq',
        "priority" INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "price_rule_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable: price_list.
    await tx`
      CREATE TABLE IF NOT EXISTS "price_list" (
        "id" TEXT NOT NULL,
        "title" TEXT,
        "status" "PriceListStatus" NOT NULL DEFAULT 'draft',
        "type" "PriceListType" NOT NULL DEFAULT 'override',
        "starts_at" TIMESTAMP(3),
        "ends_at" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "price_list_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable: credit_note (Storno / Gutschrift). amount INTEGER (cents).
    await tx`
      CREATE TABLE IF NOT EXISTS "credit_note" (
        "id" TEXT NOT NULL,
        "corrected_ref" TEXT,
        "reason" TEXT,
        "currency_code" TEXT NOT NULL,
        "amount" INTEGER NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable: credit_note_ref.
    await tx`
      CREATE TABLE IF NOT EXISTS "credit_note_ref" (
        "id" TEXT NOT NULL,
        "credit_note_id" TEXT NOT NULL,
        "ref_type" TEXT NOT NULL,
        "ref_id" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "credit_note_ref_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateIndex
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "price_set_variant_id_key" ON "price_set"("variant_id")`;
    await tx`CREATE INDEX IF NOT EXISTS "price_price_set_id_currency_code_idx" ON "price"("price_set_id", "currency_code")`;
    await tx`CREATE INDEX IF NOT EXISTS "price_rule_price_id_idx" ON "price_rule"("price_id")`;
    await tx`CREATE INDEX IF NOT EXISTS "credit_note_ref_ref_type_ref_id_idx" ON "credit_note_ref"("ref_type", "ref_id")`;

    // AddForeignKey
    await tx`ALTER TABLE "price_set" ADD CONSTRAINT "price_set_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE`;
    await tx`ALTER TABLE "price" ADD CONSTRAINT "price_price_set_id_fkey" FOREIGN KEY ("price_set_id") REFERENCES "price_set"("id") ON DELETE CASCADE ON UPDATE CASCADE`;
    await tx`ALTER TABLE "price" ADD CONSTRAINT "price_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE CASCADE ON UPDATE CASCADE`;
    await tx`ALTER TABLE "price_rule" ADD CONSTRAINT "price_rule_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "price"("id") ON DELETE CASCADE ON UPDATE CASCADE`;
    await tx`ALTER TABLE "credit_note_ref" ADD CONSTRAINT "credit_note_ref_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_note"("id") ON DELETE CASCADE ON UPDATE CASCADE`;

    // ====================================================================
    // Raw-SQL CHECK constraints: money floor + quantity-band + currency-code.
    // ====================================================================
    await tx`ALTER TABLE "price" ADD CONSTRAINT "price_amount_nonneg_check" CHECK ("amount" >= 0)`;
    await tx`ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_amount_nonneg_check" CHECK ("amount" >= 0)`;

    // Quantity-band sanity: non-negative and not inverted. NULL (unbounded) passes.
    await tx`ALTER TABLE "price" ADD CONSTRAINT "price_min_quantity_nonneg_check" CHECK ("min_quantity" >= 0)`;
    await tx`ALTER TABLE "price" ADD CONSTRAINT "price_max_quantity_nonneg_check" CHECK ("max_quantity" >= 0)`;
    await tx`ALTER TABLE "price" ADD CONSTRAINT "price_quantity_band_check" CHECK ("min_quantity" <= "max_quantity")`;

    // Currency-code shape: ISO-4217 alpha-3 UPPERCASE.
    await tx`ALTER TABLE "price" ADD CONSTRAINT "price_currency_code_iso4217_check" CHECK ("currency_code" ~ '^[A-Z]{3}$')`;
    await tx`ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_currency_code_iso4217_check" CHECK ("currency_code" ~ '^[A-Z]{3}$')`;

    // ====================================================================
    // Append-only REVOKE: an invoice / credit note can never be UPDATEd or
    // DELETEd by ordinary application traffic. Guarded on role existence.
    // ====================================================================
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE UPDATE, DELETE ON "credit_note" FROM commerce_app;
          REVOKE UPDATE, DELETE ON "credit_note_ref" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
