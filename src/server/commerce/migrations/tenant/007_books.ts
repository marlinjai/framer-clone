import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books phase 1 — `007_books`: the invoicing tier (offers, invoices, credit
 * notes) in each tenant group's own `tg_<hex32>` schema, beside the commerce
 * tables. Specified in docs/plans/2026-08-15-books-receipts-invoices-integration.md,
 * section "Phase 1 build specification (2026-10-17)", P1.1.
 *
 * Seven tables:
 *   books_company_settings   one row per company: tax status, exemption note,
 *                            sender identity, default payment terms
 *   document_number_counter  one row per company and document type: the ONLY
 *                            source of document numbers
 *   customer                 the tax fields of a recipient; name and address
 *                            live in the shared contacts database (contact_id)
 *   document_template        layout only (rendered from in phase 3)
 *   sales_document           offer, invoice and credit note in one table
 *   sales_document_line      the lines, with tax INPUTS and DERIVED values
 *   sales_document_event     the append-only audit trail
 *
 * House style (as 001 to 006): BARE names (the runner injects
 * `SET LOCAL search_path = <tg_id>, ext`), ids TEXT minted by the application,
 * `updated_at` stamped by the repository, MixedCase enum types double-quoted,
 * trigger functions `SET search_path FROM CURRENT` so their bare names resolve to
 * THIS schema whatever the caller's path is. Units: money INTEGER cents, rates
 * and discounts INTEGER basis points, quantities INTEGER thousandths, calendar
 * dates DATE (an invoice date is a calendar day; a timestamp invites a time-zone
 * shift).
 *
 * The structural guarantees, and why each exists:
 *
 *   1. `tenant_id` on every table, uuid-shaped by CHECK. One tenant group schema
 *      can hold more than one company (an auth-brain tenant), so the schema wall
 *      alone does not separate companies.
 *   2. Composite foreign keys. Every referenced table has UNIQUE (tenant_id, id)
 *      and every reference is (tenant_id, x_id) -> target(tenant_id, id). A
 *      document of company A can therefore never point at a customer, template
 *      or corrected invoice of company B, and a line or event can never belong
 *      to another company's document, whatever the application does.
 *   3. A draft never carries a number or snapshots; an issued document always
 *      carries all of them (two CHECKs). A credit note always names the invoice
 *      it corrects, and nothing else does. Reverse charge is refused unless the
 *      recipient is a business with a VAT id and the company is not a small
 *      business (the database twin of the shared guard in src/server/tax).
 *   4. Frozen after issue, by row-conditional TRIGGERS rather than a REVOKE: a
 *      REVOKE cannot keep drafts editable, binds only the app role, and was
 *      found undone by provisioning grants (CM-13). Triggers bind every role,
 *      the owner included, and survive any later GRANT. Errors carry custom
 *      SQLSTATEs so the repository and the tests can tell them apart from a
 *      permission error (42501):
 *        BK001  write to a frozen document, or to a line of a non-draft document
 *        BK002  UPDATE, DELETE or TRUNCATE on sales_document_event
 *        BK003  a number counter moved backwards
 *        BK004  a status transition that is not allowed
 *        BK005  issue with totals that do not equal the sum of the lines
 *   5. The event table is append-only twice: the trigger above, and the house
 *      REVOKE (here, and re-applied after the provisioning grants through
 *      APPEND_ONLY_TABLES in provisioning/provision.ts).
 *   6. Numbers are unique per company and type (partial unique indexes on the
 *      formatted number and on the raw counter value), and one invoice has at
 *      most one credit note (phase 1 cancels in full).
 *   7. Line positions are unique per document, DEFERRABLE INITIALLY DEFERRED,
 *      so a reorder may rewrite every position in one transaction.
 *
 * Reused enum types from 000_enums (never redefined): "CustomerType",
 * "NetOrGross", "TaxTreatment", "VariantRefSource".
 */

export const books: Migration = {
  id: '007_books',
  up: async (tx) => {
    // ====================================================================
    // Enum types.
    // ====================================================================
    await tx`CREATE TYPE "SalesDocType" AS ENUM ('offer', 'invoice', 'credit_note')`;
    await tx`CREATE TYPE "SalesDocStatus" AS ENUM ('draft', 'issued', 'sent', 'accepted', 'rejected', 'paid', 'cancelled')`;
    await tx`CREATE TYPE "SalesDocSource" AS ENUM ('editor', 'import')`;
    await tx`CREATE TYPE "SalesDocLineKind" AS ENUM ('service', 'product', 'text')`;
    await tx`CREATE TYPE "SalesDocEventType" AS ENUM ('draft_created', 'customer_set', 'issued', 'cancelled')`;
    await tx`CREATE TYPE "CompanyTaxStatus" AS ENUM ('small_business', 'regular')`;

    // ====================================================================
    // books_company_settings: one row per company.
    // ====================================================================
    await tx`
      CREATE TABLE IF NOT EXISTS "books_company_settings" (
        "tenant_id" TEXT NOT NULL,
        "tax_status" "CompanyTaxStatus" NOT NULL DEFAULT 'small_business',
        "exemption_note" TEXT NOT NULL,
        "sender_block" JSONB NOT NULL,
        "default_payment_terms_days" INTEGER NOT NULL DEFAULT 14,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "books_company_settings_pkey" PRIMARY KEY ("tenant_id"),
        CONSTRAINT "books_company_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "books_company_settings_payment_terms_check" CHECK ("default_payment_terms_days" BETWEEN 0 AND 365)
      )
    `;

    // ====================================================================
    // document_number_counter: one row per company and document type.
    // ====================================================================
    // The format: literal text, one {n} or {n:W} token (zero-padded to W digits),
    // literal text. Written with bracket classes ([{] [}]) so no backslash has to
    // survive the template literal.
    await tx`
      CREATE TABLE IF NOT EXISTS "document_number_counter" (
        "tenant_id" TEXT NOT NULL,
        "doc_type" "SalesDocType" NOT NULL,
        "next_value" BIGINT NOT NULL,
        "format" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "document_number_counter_pkey" PRIMARY KEY ("tenant_id", "doc_type"),
        CONSTRAINT "document_number_counter_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "document_number_counter_next_value_check" CHECK ("next_value" >= 1),
        CONSTRAINT "document_number_counter_format_check"
          CHECK ("format" ~ '^[A-Za-z0-9/._ -]{0,16}[{]n(:[1-9])?[}][A-Za-z0-9/._ -]{0,16}$')
      )
    `;

    // ====================================================================
    // customer: tax fields only; name and address live in the contacts database.
    // ====================================================================
    await tx`
      CREATE TABLE IF NOT EXISTS "customer" (
        "id" TEXT NOT NULL,
        "tenant_id" TEXT NOT NULL,
        "contact_id" TEXT NOT NULL,
        "customer_type" "CustomerType" NOT NULL DEFAULT 'b2c',
        "vat_id" TEXT,
        "country_code" TEXT NOT NULL DEFAULT 'DE',
        "tax_number" TEXT,
        "archived_at" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "customer_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "customer_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "customer_vat_id_check" CHECK ("vat_id" IS NULL OR "vat_id" ~ '^[A-Z]{2}[A-Z0-9+*]{2,13}$'),
        CONSTRAINT "customer_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
        -- The composite-FK target.
        CONSTRAINT "customer_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
        -- One customer per contact per company.
        CONSTRAINT "customer_tenant_id_contact_id_key" UNIQUE ("tenant_id", "contact_id")
      )
    `;

    // ====================================================================
    // document_template: layout only.
    // ====================================================================
    await tx`
      CREATE TABLE IF NOT EXISTS "document_template" (
        "id" TEXT NOT NULL,
        "tenant_id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "is_default" BOOLEAN NOT NULL DEFAULT false,
        "locale" TEXT NOT NULL DEFAULT 'de-DE',
        "logo_file_id" TEXT,
        "accent_color" TEXT,
        "footer_blocks" JSONB NOT NULL DEFAULT '[]',
        "default_intro_text" TEXT,
        "default_outro_text" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "document_template_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "document_template_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "document_template_accent_color_check" CHECK ("accent_color" IS NULL OR "accent_color" ~ '^#[0-9a-fA-F]{6}$'),
        CONSTRAINT "document_template_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "document_template_tenant_id_name_key" UNIQUE ("tenant_id", "name")
      )
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "document_template_one_default_key"
        ON "document_template" ("tenant_id")
        WHERE "is_default"
    `;

    // ====================================================================
    // sales_document: offer, invoice and credit note in one table.
    // ====================================================================
    await tx`
      CREATE TABLE IF NOT EXISTS "sales_document" (
        "id" TEXT NOT NULL,
        "tenant_id" TEXT NOT NULL,
        "doc_type" "SalesDocType" NOT NULL,
        "status" "SalesDocStatus" NOT NULL DEFAULT 'draft',
        "source" "SalesDocSource" NOT NULL DEFAULT 'editor',
        "version" INTEGER NOT NULL DEFAULT 0,
        "customer_id" TEXT,
        "template_id" TEXT,
        "corrects_document_id" TEXT,
        "source_order_id" TEXT,
        "document_number" TEXT,
        "number_value" BIGINT,
        "issue_date" DATE,
        "service_date" DATE,
        "service_period_start" DATE,
        "service_period_end" DATE,
        "due_date" DATE,
        "valid_until" DATE,
        "payment_terms_days" INTEGER NOT NULL,
        "payment_reference" TEXT,
        "contract_reference" TEXT,
        "currency_code" TEXT NOT NULL DEFAULT 'EUR',
        "tax_region" TEXT NOT NULL DEFAULT 'DE',
        "customer_type" "CustomerType",
        "vat_id" TEXT,
        "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
        "net_or_gross" "NetOrGross" NOT NULL DEFAULT 'net',
        "kleinunternehmer" BOOLEAN NOT NULL DEFAULT true,
        "tax_note" TEXT,
        "tax_profile_key" TEXT,
        "subtotal" INTEGER NOT NULL DEFAULT 0,
        "tax_amount" INTEGER NOT NULL DEFAULT 0,
        "total" INTEGER NOT NULL DEFAULT 0,
        "tax_summary" JSONB NOT NULL DEFAULT '[]',
        "customer_snapshot" JSONB,
        "sender_snapshot" JSONB,
        "intro_text" TEXT,
        "outro_text" TEXT,
        "rendered_pdf_file_id" TEXT,
        "issued_at" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "sales_document_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "sales_document_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "sales_document_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "sales_document_payment_terms_check" CHECK ("payment_terms_days" BETWEEN 0 AND 365),
        CONSTRAINT "sales_document_currency_code_check" CHECK ("currency_code" = 'EUR'),
        CONSTRAINT "sales_document_subtotal_nonneg_check" CHECK ("subtotal" >= 0),
        CONSTRAINT "sales_document_tax_amount_nonneg_check" CHECK ("tax_amount" >= 0),
        CONSTRAINT "sales_document_total_nonneg_check" CHECK ("total" >= 0),
        -- The accounting identity (as order_total_sum_check in 005).
        CONSTRAINT "sales_document_total_sum_check" CHECK ("total" = "subtotal" + "tax_amount"),
        -- A draft has no number, ever.
        CONSTRAINT "sales_document_draft_unnumbered_check" CHECK (
          "status" <> 'draft' OR (
            "document_number" IS NULL AND "number_value" IS NULL AND "issued_at" IS NULL
            AND "customer_snapshot" IS NULL AND "sender_snapshot" IS NULL
          )
        ),
        -- Anything past draft carries the complete issued field set. The import
        -- (after phase 3) may relax what an imported row must carry.
        CONSTRAINT "sales_document_issued_complete_check" CHECK (
          "status" = 'draft' OR (
            "document_number" IS NOT NULL AND "number_value" IS NOT NULL AND "issue_date" IS NOT NULL
            AND "issued_at" IS NOT NULL AND "customer_id" IS NOT NULL AND "customer_snapshot" IS NOT NULL
            AND "sender_snapshot" IS NOT NULL AND "customer_type" IS NOT NULL AND "tax_profile_key" IS NOT NULL
          ) OR "source" = 'import'
        ),
        -- A credit note names the invoice it corrects; nothing else does.
        CONSTRAINT "sales_document_credit_note_ref_check" CHECK (
          ("doc_type" = 'credit_note') = ("corrects_document_id" IS NOT NULL)
        ),
        -- The database twin of assertReverseChargeAllowed (src/server/tax).
        CONSTRAINT "sales_document_reverse_charge_check" CHECK (
          NOT "reverse_charge" OR ("customer_type" = 'b2b' AND "vat_id" IS NOT NULL AND NOT "kleinunternehmer")
        ),
        CONSTRAINT "sales_document_service_period_check" CHECK (
          ("service_period_start" IS NULL) = ("service_period_end" IS NULL)
          AND ("service_period_start" IS NULL OR "service_period_start" <= "service_period_end")
        ),
        CONSTRAINT "sales_document_customer_fkey" FOREIGN KEY ("tenant_id", "customer_id")
          REFERENCES "customer" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT "sales_document_template_fkey" FOREIGN KEY ("tenant_id", "template_id")
          REFERENCES "document_template" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT "sales_document_corrects_document_fkey" FOREIGN KEY ("tenant_id", "corrects_document_id")
          REFERENCES "sales_document" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "sales_document_number_key"
        ON "sales_document" ("tenant_id", "doc_type", "document_number")
        WHERE "document_number" IS NOT NULL
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "sales_document_number_value_key"
        ON "sales_document" ("tenant_id", "doc_type", "number_value")
        WHERE "number_value" IS NOT NULL
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "sales_document_one_credit_note_key"
        ON "sales_document" ("tenant_id", "corrects_document_id")
        WHERE "corrects_document_id" IS NOT NULL
    `;
    await tx`CREATE INDEX IF NOT EXISTS "sales_document_tenant_type_status_idx" ON "sales_document" ("tenant_id", "doc_type", "status")`;
    await tx`CREATE INDEX IF NOT EXISTS "sales_document_tenant_issue_date_idx" ON "sales_document" ("tenant_id", "issue_date")`;
    await tx`CREATE INDEX IF NOT EXISTS "sales_document_tenant_customer_idx" ON "sales_document" ("tenant_id", "customer_id")`;

    // ====================================================================
    // sales_document_line.
    // ====================================================================
    // tax_class and tax_rate_override are the INPUTS the rate is derived from;
    // tax_rate, tax_amount and tax_treatment are DERIVED. Keeping the inputs is
    // what lets a draft switched to reverse charge (rate 0) and back recompute
    // the intended 19 or 7 percent instead of silently keeping 0.
    await tx`
      CREATE TABLE IF NOT EXISTS "sales_document_line" (
        "id" TEXT NOT NULL,
        "tenant_id" TEXT NOT NULL,
        "document_id" TEXT NOT NULL,
        "position" INTEGER NOT NULL,
        "kind" "SalesDocLineKind" NOT NULL DEFAULT 'service',
        "title" TEXT NOT NULL,
        "description" TEXT,
        "quantity" INTEGER NOT NULL,
        "unit_label" TEXT NOT NULL DEFAULT 'Stk',
        "unit_price" INTEGER NOT NULL,
        "discount_bp" INTEGER NOT NULL DEFAULT 0,
        "subtotal" INTEGER NOT NULL,
        "tax_class" TEXT,
        "tax_rate_override" INTEGER,
        "tax_rate" INTEGER NOT NULL,
        "tax_amount" INTEGER NOT NULL,
        "tax_treatment" "TaxTreatment",
        "variant_ref" TEXT,
        "variant_ref_source" "VariantRefSource" NOT NULL DEFAULT 'none',
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "sales_document_line_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "sales_document_line_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "sales_document_line_position_check" CHECK ("position" >= 1),
        CONSTRAINT "sales_document_line_title_check" CHECK (length("title") BETWEEN 1 AND 300),
        CONSTRAINT "sales_document_line_description_check" CHECK ("description" IS NULL OR length("description") <= 4000),
        CONSTRAINT "sales_document_line_unit_price_check" CHECK ("unit_price" >= 0),
        CONSTRAINT "sales_document_line_discount_check" CHECK ("discount_bp" BETWEEN 0 AND 10000),
        CONSTRAINT "sales_document_line_subtotal_check" CHECK ("subtotal" >= 0),
        CONSTRAINT "sales_document_line_tax_class_check" CHECK ("tax_class" IS NULL OR "tax_class" IN ('standard', 'reduced', 'zero')),
        CONSTRAINT "sales_document_line_tax_rate_override_check" CHECK ("tax_rate_override" IS NULL OR "tax_rate_override" BETWEEN 0 AND 10000),
        CONSTRAINT "sales_document_line_tax_rate_check" CHECK ("tax_rate" BETWEEN 0 AND 10000),
        CONSTRAINT "sales_document_line_tax_amount_check" CHECK ("tax_amount" >= 0),
        CONSTRAINT "sales_document_line_kind_check" CHECK (
          ("kind" = 'text' AND "quantity" = 0 AND "unit_price" = 0 AND "discount_bp" = 0 AND "subtotal" = 0
            AND "tax_rate" = 0 AND "tax_amount" = 0 AND "tax_treatment" IS NULL)
          OR ("kind" <> 'text' AND "quantity" > 0 AND "tax_treatment" IS NOT NULL)
        ),
        CONSTRAINT "sales_document_line_variant_ref_check" CHECK (("variant_ref_source" = 'none') = ("variant_ref" IS NULL)),
        CONSTRAINT "sales_document_line_document_fkey" FOREIGN KEY ("tenant_id", "document_id")
          REFERENCES "sales_document" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT "sales_document_line_position_key" UNIQUE ("document_id", "position") DEFERRABLE INITIALLY DEFERRED
      )
    `;
    await tx`CREATE INDEX IF NOT EXISTS "sales_document_line_document_idx" ON "sales_document_line" ("tenant_id", "document_id", "position")`;

    // ====================================================================
    // sales_document_event: the append-only audit trail (no updated_at).
    // ====================================================================
    await tx`
      CREATE TABLE IF NOT EXISTS "sales_document_event" (
        "id" TEXT NOT NULL,
        "tenant_id" TEXT NOT NULL,
        "document_id" TEXT NOT NULL,
        "event_type" "SalesDocEventType" NOT NULL,
        "from_status" "SalesDocStatus",
        "to_status" "SalesDocStatus",
        "actor_user_id" TEXT,
        "payload" JSONB NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "sales_document_event_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "sales_document_event_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "sales_document_event_document_fkey" FOREIGN KEY ("tenant_id", "document_id")
          REFERENCES "sales_document" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;
    await tx`CREATE INDEX IF NOT EXISTS "sales_document_event_document_idx" ON "sales_document_event" ("tenant_id", "document_id", "created_at")`;

    // ====================================================================
    // Trigger 1: sales_document_guard (BK001, BK004, BK005).
    // ====================================================================
    // Order of checks on UPDATE:
    //   a. a status change must be an allowed transition of the document type's
    //      machine (BK004); "-> cancelled" on an invoice additionally needs an
    //      issued credit note correcting it (cancelled only via a credit note,
    //      never by mutation);
    //   b. draft -> draft: free (drafts are editable);
    //   c. draft -> issued: the stored totals must equal the sums of the lines
    //      (BK005); the CHECKs enforce the number and the snapshots;
    //   d. offer issued -> draft (only while unsent): allowed; the draft CHECK
    //      forces the number and snapshots to be cleared;
    //   e. anything else past draft: every column is frozen except status,
    //      rendered_pdf_file_id and updated_at (BK001), and rendered_pdf_file_id
    //      may only go from NULL to a value (BK001). Comparing whole rows is
    //      stricter than a column list and cannot go stale when a column is added.
    // DELETE always raises BK001: a draft is never deleted either (it carries its
    // draft_created event; an abandoned draft stays a draft and consumes nothing).
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          transition TEXT;
          allowed BOOLEAN;
          lines_subtotal BIGINT;
          lines_tax BIGINT;
      BEGIN
          IF TG_OP = 'DELETE' THEN
              RAISE EXCEPTION 'sales_document % cannot be deleted', OLD."id"
                  USING ERRCODE = 'BK001';
          END IF;

          IF NEW."status" IS DISTINCT FROM OLD."status" THEN
              transition := OLD."status"::text || '>' || NEW."status"::text;
              allowed := CASE OLD."doc_type"
                  WHEN 'invoice' THEN transition IN (
                      'draft>issued', 'issued>sent', 'sent>paid',
                      'issued>cancelled', 'sent>cancelled', 'paid>cancelled')
                  WHEN 'credit_note' THEN transition IN ('draft>issued', 'issued>sent')
                  WHEN 'offer' THEN transition IN (
                      'draft>issued', 'issued>sent', 'issued>draft',
                      'sent>accepted', 'sent>rejected', 'sent>cancelled')
                  ELSE false
              END;
              IF NOT allowed THEN
                  RAISE EXCEPTION 'sales_document %: transition % is not allowed for a %',
                      OLD."id", transition, OLD."doc_type"
                      USING ERRCODE = 'BK004';
              END IF;
              IF OLD."doc_type" = 'invoice' AND NEW."status" = 'cancelled' AND NOT EXISTS (
                  SELECT 1 FROM "sales_document" cn
                   WHERE cn."tenant_id" = OLD."tenant_id"
                     AND cn."corrects_document_id" = OLD."id"
                     AND cn."doc_type" = 'credit_note'
                     AND cn."status" IN ('issued', 'sent')
              ) THEN
                  RAISE EXCEPTION 'sales_document %: an invoice is cancelled only through an issued credit note', OLD."id"
                      USING ERRCODE = 'BK004';
              END IF;
          END IF;

          IF OLD."status" = 'draft' AND NEW."status" = 'draft' THEN
              RETURN NEW;
          END IF;

          IF OLD."status" = 'draft' AND NEW."status" = 'issued' THEN
              SELECT COALESCE(SUM("subtotal"), 0), COALESCE(SUM("tax_amount"), 0)
                INTO lines_subtotal, lines_tax
                FROM "sales_document_line"
               WHERE "tenant_id" = NEW."tenant_id" AND "document_id" = NEW."id";
              IF lines_subtotal <> NEW."subtotal" OR lines_tax <> NEW."tax_amount" THEN
                  RAISE EXCEPTION 'sales_document %: totals (%, %) do not equal the lines (%, %)',
                      NEW."id", NEW."subtotal", NEW."tax_amount", lines_subtotal, lines_tax
                      USING ERRCODE = 'BK005';
              END IF;
              RETURN NEW;
          END IF;

          IF OLD."doc_type" = 'offer' AND OLD."status" = 'issued' AND NEW."status" = 'draft' THEN
              RETURN NEW;
          END IF;

          IF (to_jsonb(NEW) - ARRAY['status', 'rendered_pdf_file_id', 'updated_at'])
             IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'rendered_pdf_file_id', 'updated_at']) THEN
              RAISE EXCEPTION 'sales_document % is frozen (status %)', OLD."id", OLD."status"
                  USING ERRCODE = 'BK001';
          END IF;
          IF OLD."rendered_pdf_file_id" IS NOT NULL
             AND NEW."rendered_pdf_file_id" IS DISTINCT FROM OLD."rendered_pdf_file_id" THEN
              RAISE EXCEPTION 'sales_document %: rendered_pdf_file_id is set once and never changed', OLD."id"
                  USING ERRCODE = 'BK001';
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_guard" ON "sales_document"`;
    await tx`
      CREATE TRIGGER "sales_document_guard"
          BEFORE UPDATE OR DELETE ON "sales_document"
          FOR EACH ROW
          EXECUTE FUNCTION "sales_document_guard"()
    `;

    // ====================================================================
    // Trigger 2: sales_document_line_guard (BK001).
    // ====================================================================
    // A line may be written only while every parent it touches is a draft. The
    // parent is read FOR SHARE, which serializes with an issue that holds the
    // parent FOR UPDATE. A parent that does not exist (or belongs to another
    // company) is left to the composite foreign key, so a cross-company insert
    // fails as the FK violation it is.
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_line_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          parent_status "SalesDocStatus";
      BEGIN
          IF TG_OP IN ('INSERT', 'UPDATE') THEN
              SELECT "status" INTO parent_status
                FROM "sales_document"
               WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."document_id"
                 FOR SHARE;
              IF FOUND AND parent_status <> 'draft' THEN
                  RAISE EXCEPTION 'sales_document % is not a draft (status %): its lines are frozen',
                      NEW."document_id", parent_status
                      USING ERRCODE = 'BK001';
              END IF;
          END IF;
          IF TG_OP IN ('UPDATE', 'DELETE') THEN
              SELECT "status" INTO parent_status
                FROM "sales_document"
               WHERE "tenant_id" = OLD."tenant_id" AND "id" = OLD."document_id"
                 FOR SHARE;
              IF FOUND AND parent_status <> 'draft' THEN
                  RAISE EXCEPTION 'sales_document % is not a draft (status %): its lines are frozen',
                      OLD."document_id", parent_status
                      USING ERRCODE = 'BK001';
              END IF;
          END IF;
          IF TG_OP = 'DELETE' THEN
              RETURN OLD;
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_line_guard" ON "sales_document_line"`;
    await tx`
      CREATE TRIGGER "sales_document_line_guard"
          BEFORE INSERT OR UPDATE OR DELETE ON "sales_document_line"
          FOR EACH ROW
          EXECUTE FUNCTION "sales_document_line_guard"()
    `;

    // ====================================================================
    // Trigger 3: sales_document_event_append_only (BK002).
    // ====================================================================
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_event_append_only"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          RAISE EXCEPTION 'sales_document_event is append-only (% refused)', TG_OP
              USING ERRCODE = 'BK002';
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_event_append_only" ON "sales_document_event"`;
    await tx`
      CREATE TRIGGER "sales_document_event_append_only"
          BEFORE UPDATE OR DELETE ON "sales_document_event"
          FOR EACH ROW
          EXECUTE FUNCTION "sales_document_event_append_only"()
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_event_no_truncate" ON "sales_document_event"`;
    await tx`
      CREATE TRIGGER "sales_document_event_no_truncate"
          BEFORE TRUNCATE ON "sales_document_event"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "sales_document_event_append_only"()
    `;

    // ====================================================================
    // Trigger 4: document_number_counter_monotonic (BK003).
    // ====================================================================
    await tx`
      CREATE OR REPLACE FUNCTION "document_number_counter_monotonic"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF NEW."next_value" < OLD."next_value" THEN
              RAISE EXCEPTION 'document_number_counter (%, %) cannot move backwards (% to %)',
                  OLD."tenant_id", OLD."doc_type", OLD."next_value", NEW."next_value"
                  USING ERRCODE = 'BK003';
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "document_number_counter_monotonic" ON "document_number_counter"`;
    await tx`
      CREATE TRIGGER "document_number_counter_monotonic"
          BEFORE UPDATE ON "document_number_counter"
          FOR EACH ROW
          EXECUTE FUNCTION "document_number_counter_monotonic"()
    `;

    // ====================================================================
    // The house REVOKE on the append-only event table (re-applied after the
    // provisioning grants through APPEND_ONLY_TABLES). Guarded on role existence.
    // ====================================================================
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON "sales_document_event" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
