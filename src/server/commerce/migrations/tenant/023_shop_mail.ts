import type { Migration } from '@marlinjai/tenant-db';

/**
 * The shop's receipt email, `023_shop_mail` (docs/plans/2026-10-27-shop-receipt-email.md). Purely additive: two
 * tables.
 *
 *   1. `shop_mail_connection`: the company's Lumitra Mail workspace, chosen once by an owner on the payments page:
 *      the workspace and sending account, the `send` key Lumitra Mail made for this shop (sealed with
 *      SHOP_MAIL_KEY, never stored in the clear), and the ids of the two templates installed there. One row per
 *      company; disconnecting deletes it (the key is revoked first).
 *   2. `shop_mail`: the outbox, one row per order and kind of mail (`order_confirmation` when the receipt is
 *      issued, `late_refund` when a late payment had to be refunded). Written only while the company is
 *      connected; retried until Lumitra Mail took the letter (`sent`), the recipient is blocked there
 *      (`blocked`, never retried), or the attempts ran out (`failed`, with the reason). Kept apart from
 *      `order_payment`, whose guarded state machine is about money, not mail. `letter` is the letter as built at
 *      its first attempt (recipient, language, values, template, sending account, workspace): every retry sends
 *      exactly it, because Lumitra Mail refuses an idempotency key repeated with another body.
 *
 * House style as 007 to 022: BARE names, ids TEXT. Re-runnable.
 */
export const shopMail: Migration = {
  id: '023_shop_mail',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "shop_mail_connection" (
          "tenant_id"          TEXT         NOT NULL,
          "workspace_id"       TEXT         NOT NULL,
          "workspace_name"     TEXT         NOT NULL,
          "provider_id"        TEXT         NOT NULL,
          "sender"             TEXT         NOT NULL,
          "api_key_id"         TEXT         NOT NULL,
          "api_key_sealed"     TEXT         NOT NULL,
          "template_ids"       JSONB        NOT NULL,
          "templates_version"  TEXT         NOT NULL,
          "connected_by"       TEXT         NOT NULL,
          "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at"         TIMESTAMP(3) NOT NULL,
          CONSTRAINT "shop_mail_connection_pkey" PRIMARY KEY ("tenant_id"),
          CONSTRAINT "shop_mail_connection_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "shop_mail_connection_template_ids_check" CHECK (jsonb_typeof("template_ids") = 'object'),
          CONSTRAINT "shop_mail_connection_sealed_check" CHECK ("api_key_sealed" LIKE 'v%:%')
      )
    `;
    await tx`
      CREATE TABLE IF NOT EXISTS "shop_mail" (
          "tenant_id"        TEXT         NOT NULL,
          "order_id"         TEXT         NOT NULL,
          "kind"             TEXT         NOT NULL,
          "status"           TEXT         NOT NULL DEFAULT 'pending',
          "attempts"         INTEGER      NOT NULL DEFAULT 0,
          "next_attempt_at"  TIMESTAMP(3) NOT NULL,
          "last_error"       TEXT,
          "mailing_id"       TEXT,
          "letter"           JSONB,
          "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at"       TIMESTAMP(3) NOT NULL,
          CONSTRAINT "shop_mail_pkey" PRIMARY KEY ("tenant_id", "order_id", "kind"),
          CONSTRAINT "shop_mail_kind_check" CHECK ("kind" IN ('order_confirmation', 'late_refund')),
          CONSTRAINT "shop_mail_status_check" CHECK ("status" IN ('pending', 'sent', 'blocked', 'failed')),
          CONSTRAINT "shop_mail_attempts_check" CHECK ("attempts" >= 0),
          CONSTRAINT "shop_mail_error_check" CHECK ("last_error" IS NULL OR length("last_error") <= 1000),
          CONSTRAINT "shop_mail_letter_check" CHECK ("letter" IS NULL OR jsonb_typeof("letter") = 'object'),
          CONSTRAINT "shop_mail_order_fkey" FOREIGN KEY ("tenant_id", "order_id")
              REFERENCES "order" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;
    await tx`CREATE INDEX IF NOT EXISTS "shop_mail_due_idx" ON "shop_mail" ("next_attempt_at") WHERE "status" = 'pending'`;
  },
};
