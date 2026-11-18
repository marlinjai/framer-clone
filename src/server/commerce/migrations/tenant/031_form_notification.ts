import type { Migration } from '@marlinjai/tenant-db';

/**
 * Form notification emails, `031_form_notification` (docs/plans/2026-10-23-published-site-essentials.md, "Form
 * notification emails"). Purely additive: one table, nothing existing changes.
 *
 * `form_notification` is the outbox of the email that tells a site owner about a new form submission: one row per
 * submission, written in the transaction that stores the submission, so a crash in between loses no letter and a
 * failed letter never loses the submission. The row's primary key IS the submission id, with a foreign key that
 * CASCADES on delete: the owner deleting a submission, the project delete and the company erasure (which all
 * delete `form_submission` rows) take the notification, and so the frozen letter that holds the visitor's words,
 * with them. Nothing here needs its own deletion path.
 *
 *   status    pending  waiting for its attempt or its next one (the `form_mail` job owns the schedule)
 *             sent     Lumitra Mail took the letter (its mailing id kept)
 *             blocked  the address is blocked for transactional mail there (bounce, complaint)
 *             failed   Lumitra Mail kept refusing, or three days of failures; `last_error` says why
 *             skipped  nothing was sent: `last_error` is `not_connected` (the company has no Lumitra Mail
 *                      connection) or `no_recipient` (neither the form nor the site names an address)
 *   round     1 for the first letter; the owner's "send again" increments it, which starts a new job and a new
 *             idempotency key (Lumitra Mail refuses a key repeated with another body); `round_started_at` is
 *             when the current round began, the start of its three days of retries
 *   letter    the letter as built at its first attempt (recipient, language, values, template, sending
 *             account, workspace), sent unchanged on every retry; emptied once the letter is settled, because it
 *             carries the visitor's words and nothing needs them after that
 *
 * The recipient is decided at submit time from the PUBLISHED form (its address, else the site's contact email),
 * never from the request, and frozen in `recipient`. `tenant_id` is the tenant group, as in 017; the company is
 * `company_id` (the `shop_mail_connection` key and the job's tenant).
 *
 * House style as 017 and 023: BARE names, ids TEXT. Re-runnable.
 */
export const formNotification: Migration = {
  id: '031_form_notification',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "form_notification" (
          "submission_id"  TEXT         NOT NULL,
          "tenant_id"      TEXT         NOT NULL,
          "company_id"     TEXT         NOT NULL,
          "recipient"      TEXT,
          "status"         TEXT         NOT NULL DEFAULT 'pending',
          "round"          INTEGER      NOT NULL DEFAULT 1,
          "round_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "last_error"     TEXT,
          "mailing_id"     TEXT,
          "letter"         JSONB,
          "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at"     TIMESTAMP(3) NOT NULL,
          CONSTRAINT "form_notification_pkey" PRIMARY KEY ("submission_id"),
          CONSTRAINT "form_notification_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "form_notification_status_check"
              CHECK ("status" IN ('pending', 'sent', 'blocked', 'failed', 'skipped')),
          CONSTRAINT "form_notification_round_check" CHECK ("round" >= 1),
          CONSTRAINT "form_notification_recipient_check" CHECK ("recipient" IS NULL OR length("recipient") <= 254),
          CONSTRAINT "form_notification_error_check" CHECK ("last_error" IS NULL OR length("last_error") <= 1000),
          CONSTRAINT "form_notification_letter_check" CHECK ("letter" IS NULL OR jsonb_typeof("letter") = 'object'),
          CONSTRAINT "form_notification_submission_fkey" FOREIGN KEY ("submission_id")
              REFERENCES "form_submission" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
      )
    `;
    // Company-wide reads (the owner's overview of what failed) by company and status.
    await tx`
      CREATE INDEX IF NOT EXISTS "form_notification_company_idx" ON "form_notification" ("tenant_id", "company_id", "status")
    `;
  },
};
