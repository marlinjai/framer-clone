import type { Migration } from '@marlinjai/tenant-db';

/**
 * The payment of an order and its receipt, `021_order_payment` (docs/plans/2026-10-25-catalogue-design.md,
 * "Checkout, payment and receipt", slice 4). Purely additive: two new tables and one partial unique index.
 *
 * The placed order (005) stays append-only: it is the server-priced snapshot of what was bought. What changes
 * over its life (waiting for the payment, paid, failed, abandoned, expired, refunded, its receipt) lives in
 * `order_payment`, one row per order, with its own guarded state machine.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. One payment per order (primary key (tenant_id, order_id), composite foreign key to the order of the
 *      same company). Amount, currency, platform fee, provider and order are fixed once written (BK018), so a
 *      later change can never re-price a payment; the buyer may be given or corrected only while pending.
 *   2. The platform fee is computed once at checkout and recorded: `application_fee_amount`, 1% of the
 *      charged total rounded half up in the currency's minor unit (parent plan, decision 12); the CHECK keeps
 *      it within the amount.
 *   3. The state machine (BK018 on any other move): `pending` goes to `paid`, `failed`, `cancelled` or
 *      `expired`; a closed one (`failed`, `cancelled`, `expired`) goes to `paid` when a late success could
 *      re-reserve the stock, or to `refunded` when it could not; `paid` goes to `refunded`. A paid payment
 *      carries `paid_at`, a failed, cancelled or expired one `closed_at`.
 *   4. The receipt is linked once: `receipt_document_id` goes from NULL to a Books document of the same
 *      company and never changes again (BK018), and only a paid payment has one. `receipt_error` keeps why
 *      the last attempt to issue it failed, for the retry and for the owner.
 *   5. One receipt per order in the Books: a partial unique index on sales_document (tenant_id,
 *      source_order_id), so two concurrent attempts can never issue two invoices for one order.
 *   6. Provider events are recorded once (`payment_event`, primary key (provider, event_id)), append-only for
 *      every role (BK019) plus the house REVOKE: a webhook delivered twice changes nothing the second time.
 *   7. The buyer as given at checkout (`buyer`, a JSON object: name, email, address, optional company and VAT
 *      id; empty until the buyer is entered, src/server/commerce/payment/buyer.ts) is what the receipt's contact is made from; it is kept with the payment, not the order, because
 *      it is personal data the order snapshot does not need.
 *
 * House style as 007 to 020: BARE names, ids TEXT minted by the application, trigger functions
 * `SET search_path FROM CURRENT`, custom SQLSTATEs BK018 and BK019. Re-runnable.
 */
export const orderPayment: Migration = {
  id: '021_order_payment',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "order_payment" (
          "tenant_id"               TEXT         NOT NULL,
          "order_id"                TEXT         NOT NULL,
          "status"                  TEXT         NOT NULL DEFAULT 'pending',
          "provider"                TEXT         NOT NULL,
          "provider_payment_id"     TEXT,
          "amount"                  INTEGER      NOT NULL,
          "currency_code"           TEXT         NOT NULL,
          "application_fee_amount"  INTEGER      NOT NULL,
          "buyer"                   JSONB        NOT NULL,
          "expires_at"              TIMESTAMP(3) NOT NULL,
          "paid_at"                 TIMESTAMP(3),
          "closed_at"               TIMESTAMP(3),
          "failure_code"            TEXT,
          "refund_id"               TEXT,
          "receipt_document_id"     TEXT,
          "receipt_error"           TEXT,
          "version"                 INTEGER      NOT NULL DEFAULT 0,
          "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at"              TIMESTAMP(3) NOT NULL,
          CONSTRAINT "order_payment_pkey" PRIMARY KEY ("tenant_id", "order_id"),
          CONSTRAINT "order_payment_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "order_payment_status_check"
              CHECK ("status" IN ('pending', 'paid', 'failed', 'cancelled', 'expired', 'refunded')),
          CONSTRAINT "order_payment_provider_check" CHECK ("provider" IN ('demo', 'stripe')),
          CONSTRAINT "order_payment_amount_check" CHECK ("amount" > 0),
          CONSTRAINT "order_payment_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
          CONSTRAINT "order_payment_fee_check" CHECK ("application_fee_amount" BETWEEN 0 AND "amount"),
          CONSTRAINT "order_payment_buyer_check" CHECK (jsonb_typeof("buyer") = 'object'),
          CONSTRAINT "order_payment_paid_check" CHECK ("status" <> 'paid' OR "paid_at" IS NOT NULL),
          CONSTRAINT "order_payment_closed_check"
              CHECK ("status" NOT IN ('failed', 'cancelled', 'expired') OR "closed_at" IS NOT NULL),
          CONSTRAINT "order_payment_receipt_check" CHECK ("receipt_document_id" IS NULL OR "status" IN ('paid', 'refunded')),
          CONSTRAINT "order_payment_receipt_error_check" CHECK ("receipt_error" IS NULL OR length("receipt_error") <= 2000),
          CONSTRAINT "order_payment_order_fkey" FOREIGN KEY ("tenant_id", "order_id")
              REFERENCES "order" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
          CONSTRAINT "order_payment_receipt_fkey" FOREIGN KEY ("tenant_id", "receipt_document_id")
              REFERENCES "sales_document" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "order_payment_provider_payment_key"
        ON "order_payment" ("provider", "provider_payment_id")
        WHERE "provider_payment_id" IS NOT NULL
    `;
    await tx`CREATE INDEX IF NOT EXISTS "order_payment_open_idx" ON "order_payment" ("status", "expires_at") WHERE "status" = 'pending'`;

    // Guarantee 5.
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "sales_document_tenant_source_order_key"
        ON "sales_document" ("tenant_id", "source_order_id")
        WHERE "source_order_id" IS NOT NULL
    `;

    // Guarantees 1, 3 and 4.
    await tx`
      CREATE OR REPLACE FUNCTION "order_payment_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          transition TEXT;
      BEGIN
          IF TG_OP = 'DELETE' THEN
              RAISE EXCEPTION 'order_payment of order % cannot be deleted', OLD."order_id" USING ERRCODE = 'BK018';
          END IF;
          IF TG_OP = 'INSERT' THEN
              IF NEW."status" <> 'pending' OR NEW."receipt_document_id" IS NOT NULL THEN
                  RAISE EXCEPTION 'order_payment of order %: a payment starts pending without a receipt', NEW."order_id"
                      USING ERRCODE = 'BK018';
              END IF;
              RETURN NEW;
          END IF;
          IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
             OR NEW."provider" IS DISTINCT FROM OLD."provider" OR NEW."amount" IS DISTINCT FROM OLD."amount"
             OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
             OR NEW."application_fee_amount" IS DISTINCT FROM OLD."application_fee_amount"
             OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
              RAISE EXCEPTION 'order_payment of order %: order, provider, amount, currency and fee are fixed', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          IF NEW."buyer" IS DISTINCT FROM OLD."buyer" AND OLD."status" <> 'pending' THEN
              RAISE EXCEPTION 'order_payment of order %: the buyer is fixed once the payment is decided', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          IF OLD."provider_payment_id" IS NOT NULL AND NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id" THEN
              RAISE EXCEPTION 'order_payment of order %: the provider payment id is set once', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          IF OLD."receipt_document_id" IS NOT NULL AND NEW."receipt_document_id" IS DISTINCT FROM OLD."receipt_document_id" THEN
              RAISE EXCEPTION 'order_payment of order %: the receipt is linked once', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          IF NEW."status" IS DISTINCT FROM OLD."status" THEN
              transition := OLD."status" || '>' || NEW."status";
              IF transition NOT IN (
                  'pending>paid', 'pending>failed', 'pending>cancelled', 'pending>expired',
                  'failed>paid', 'cancelled>paid', 'expired>paid',
                  'failed>refunded', 'cancelled>refunded', 'expired>refunded', 'paid>refunded'
              ) THEN
                  RAISE EXCEPTION 'order_payment of order %: % is not allowed', OLD."order_id", transition
                      USING ERRCODE = 'BK018';
              END IF;
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "order_payment_guard" ON "order_payment"`;
    await tx`
      CREATE TRIGGER "order_payment_guard"
          BEFORE INSERT OR UPDATE OR DELETE ON "order_payment"
          FOR EACH ROW EXECUTE FUNCTION "order_payment_guard"()
    `;

    // Guarantee 6.
    await tx`
      CREATE TABLE IF NOT EXISTS "payment_event" (
          "provider"     TEXT         NOT NULL,
          "event_id"     TEXT         NOT NULL,
          "tenant_id"    TEXT         NOT NULL,
          "order_id"     TEXT         NOT NULL,
          "event_type"   TEXT         NOT NULL,
          "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "payment_event_pkey" PRIMARY KEY ("provider", "event_id"),
          CONSTRAINT "payment_event_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "payment_event_provider_check" CHECK ("provider" IN ('demo', 'stripe')),
          CONSTRAINT "payment_event_type_check"
              CHECK ("event_type" IN ('payment_succeeded', 'payment_failed', 'checkout_cancelled', 'checkout_expired')),
          CONSTRAINT "payment_event_id_check" CHECK (length("event_id") BETWEEN 1 AND 255),
          CONSTRAINT "payment_event_payment_fkey" FOREIGN KEY ("tenant_id", "order_id")
              REFERENCES "order_payment" ("tenant_id", "order_id") ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;
    await tx`
      CREATE OR REPLACE FUNCTION "payment_event_append_only"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          RAISE EXCEPTION 'payment_event is append-only (% refused)', TG_OP USING ERRCODE = 'BK019';
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "payment_event_append_only" ON "payment_event"`;
    await tx`
      CREATE TRIGGER "payment_event_append_only"
          BEFORE UPDATE OR DELETE ON "payment_event"
          FOR EACH ROW EXECUTE FUNCTION "payment_event_append_only"()
    `;
    await tx`DROP TRIGGER IF EXISTS "payment_event_no_truncate" ON "payment_event"`;
    await tx`
      CREATE TRIGGER "payment_event_no_truncate"
          BEFORE TRUNCATE ON "payment_event"
          FOR EACH STATEMENT EXECUTE FUNCTION "payment_event_append_only"()
    `;
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON "payment_event" FROM commerce_app;
          REVOKE DELETE, TRUNCATE ON "order_payment" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
