import type { Migration } from '@marlinjai/tenant-db';

/**
 * Published site essentials, decision 4, `016_form_submissions`: what a visitor
 * sends through a form on a published site
 * (docs/plans/2026-10-23-published-site-essentials.md). Purely additive: one new
 * table, nothing existing changes.
 *
 * A row is one accepted submission: which site (the project id, `site_id`) and
 * which form (the form component's id and the name the owner gave it) received
 * it, on which page, and the submitted fields as an ordered JSON list of
 * `{ key, label, type, value }` (src/lib/forms/definition.ts). The values were
 * validated by the server against the PUBLISHED form before the insert
 * (src/server/forms/submit.ts); the browser never decides what is stored.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. No IP address, in clear or hashed. Spam protection (the per-IP and
 *      per-form rate limits) runs in memory and never needs a stored address,
 *      so the General Data Protection Regulation (GDPR) data minimisation rule
 *      says: do not keep it. A hash of an IPv4 address is reversible by trying
 *      all four billion of them, so hashing would not make it anonymous anyway.
 *   2. Every row names its owners: `tenant_id` (the tenant group, the same id
 *      the schema is named after), `workspace_id` (the company's workspace) and
 *      `site_id` (the project). So the project delete removes a project's rows
 *      (`deleteSiteSubmissions`, called by DELETE /api/projects/<id>), a
 *      company erasure removes them by workspace (`deleteWorkspaceSubmissions`)
 *      or with the whole `tg_<id>` schema, and the owner deletes one row from
 *      the submissions view. Every delete is a real DELETE, never a flag.
 *   3. Bounded size: at most 64 KiB of field JSON per row, a form name of 1 to
 *      120 characters, ids of at most 200. The endpoint refuses a larger body
 *      long before this; the CHECKs keep any other writer inside the same
 *      bounds.
 *   4. `read_at` is the owner's "read" mark (NULL while unread), the only column
 *      that ever changes after the insert.
 *
 * House style as 015: BARE names, ids TEXT minted by the application, the
 * tenant id check. No trigger and no custom SQLSTATE. No REVOKE: commerce_app
 * reads, inserts, updates (`read_at`) and deletes this table through the
 * provisioning and fleet grants like any mutable table. Re-runnable: IF NOT
 * EXISTS throughout.
 */

export const formSubmissions: Migration = {
  id: '016_form_submissions',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "form_submission" (
          "id"            TEXT         NOT NULL,
          "tenant_id"     TEXT         NOT NULL,
          "workspace_id"  TEXT         NOT NULL,
          "site_id"       TEXT         NOT NULL,
          "page_id"       TEXT         NOT NULL,
          "page_path"     TEXT         NOT NULL,
          "form_id"       TEXT         NOT NULL,
          "form_name"     TEXT         NOT NULL,
          "fields"        JSONB        NOT NULL,
          "read_at"       TIMESTAMP(3),
          "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "form_submission_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "form_submission_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "form_submission_ids_check"
              CHECK (length("id") BETWEEN 1 AND 200
                     AND length("workspace_id") BETWEEN 1 AND 200
                     AND length("site_id") BETWEEN 1 AND 200
                     AND length("page_id") BETWEEN 1 AND 200
                     AND length("form_id") BETWEEN 1 AND 200),
          CONSTRAINT "form_submission_page_path_check" CHECK (length("page_path") BETWEEN 1 AND 2000),
          CONSTRAINT "form_submission_form_name_check" CHECK (length("form_name") BETWEEN 1 AND 120),
          CONSTRAINT "form_submission_fields_check"
              CHECK (jsonb_typeof("fields") = 'array' AND octet_length("fields"::text) <= 65536)
      )
    `;

    // The submissions view: one site's rows, newest first, optionally one form.
    await tx`
      CREATE INDEX IF NOT EXISTS "form_submission_site_created_idx"
          ON "form_submission" ("tenant_id", "site_id", "created_at" DESC, "id" DESC)
    `;
    await tx`
      CREATE INDEX IF NOT EXISTS "form_submission_site_form_created_idx"
          ON "form_submission" ("tenant_id", "site_id", "form_id", "created_at" DESC, "id" DESC)
    `;
    // Company erasure by workspace.
    await tx`
      CREATE INDEX IF NOT EXISTS "form_submission_workspace_idx"
          ON "form_submission" ("tenant_id", "workspace_id")
    `;
  },
};
