import type { Migration } from '@marlinjai/tenant-db';

/**
 * The company's payment account, `022_payment_account` (docs/plans/2026-10-25-catalogue-design.md,
 * "Checkout, payment and receipt", item 3; slice 5). Purely additive: one table.
 *
 * Stripe Connect with direct charges: each company holds its own Stripe account (a full-dashboard account the
 * business owns, Stripe bills it directly), the platform connects to it, and a shop payment is charged on
 * that account with the 1% platform fee taken as the application fee. This table remembers which account a
 * company connected and whether it can take payments yet.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. One account per company and provider (primary key (tenant_id, provider)), and one company per
 *      account (unique (provider, account_id)): a webhook naming an account resolves to exactly one company.
 *   2. The account id never changes once set (BK020): reconnecting another account is a deliberate
 *      disconnect (a new row after the old one is removed by an operator), never a silent overwrite that
 *      would send a company's money to another account.
 *   3. `status` is derived from the provider's own flags and kept with them: `pending` until the provider
 *      reports the account can take charges, `ready` when it can, `restricted` when it later cannot.
 *
 * House style as 007 to 021: BARE names, trigger functions `SET search_path FROM CURRENT`, custom SQLSTATE
 * BK020. Re-runnable.
 */
export const paymentAccount: Migration = {
  id: '022_payment_account',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "payment_account" (
          "tenant_id"          TEXT         NOT NULL,
          "provider"           TEXT         NOT NULL,
          "account_id"         TEXT         NOT NULL,
          "status"             TEXT         NOT NULL DEFAULT 'pending',
          "charges_enabled"    BOOLEAN      NOT NULL DEFAULT false,
          "details_submitted"  BOOLEAN      NOT NULL DEFAULT false,
          "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at"         TIMESTAMP(3) NOT NULL,
          CONSTRAINT "payment_account_pkey" PRIMARY KEY ("tenant_id", "provider"),
          CONSTRAINT "payment_account_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "payment_account_provider_check" CHECK ("provider" IN ('stripe')),
          CONSTRAINT "payment_account_account_check" CHECK ("account_id" ~ '^acct_[A-Za-z0-9]{1,64}$'),
          CONSTRAINT "payment_account_status_check" CHECK ("status" IN ('pending', 'ready', 'restricted')),
          CONSTRAINT "payment_account_ready_check" CHECK ("status" <> 'ready' OR "charges_enabled"),
          CONSTRAINT "payment_account_account_key" UNIQUE ("provider", "account_id")
      )
    `;
    await tx`
      CREATE OR REPLACE FUNCTION "payment_account_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."provider" IS DISTINCT FROM OLD."provider"
             OR NEW."account_id" IS DISTINCT FROM OLD."account_id" THEN
              RAISE EXCEPTION 'payment_account of company %: the connected account is fixed', OLD."tenant_id"
                  USING ERRCODE = 'BK020';
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "payment_account_guard" ON "payment_account"`;
    await tx`
      CREATE TRIGGER "payment_account_guard"
          BEFORE UPDATE ON "payment_account"
          FOR EACH ROW EXECUTE FUNCTION "payment_account_guard"()
    `;
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE DELETE, TRUNCATE ON "payment_account" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
