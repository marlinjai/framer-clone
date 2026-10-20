import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books, `010_books_upload_import`: importing past invoices by uploading their
 * PDFs in the editor (docs/plans/2026-10-20-books-upload-import.md). 009 is
 * deployed and never edited; this migration changes it forward.
 *
 * The changes, and why each exists:
 *
 *   1. An imported document may carry a printed number that does not follow
 *      the company's number format ("RE-2021-0012" while the counter prints
 *      plain integers): it is kept as printed in `document_number`, and
 *      `number_value` stays NULL (it takes no part in the counter). 007's
 *      issued-field CHECK required `number_value` on an import too; its import
 *      branch is re-created without it. Uniqueness stays: the partial unique
 *      index on (tenant_id, doc_type, document_number) of 007 covers every
 *      numbered document. Editor documents are unchanged (their branch still
 *      requires the number value).
 *   2. A regular-taxation historical invoice can print a discount line with
 *      VAT, so its tax amount is negative too. 007's `tax_amount >= 0` line
 *      CHECK moves into the line guard exactly like 009 moved the unit price and
 *      subtotal CHECKs: a negative tax amount only on an import (lines written
 *      before their document) and on the draft credit note cancelling one, as
 *      the exact copy of one of its lines, rate and tax included (BK008). The
 *      document guard's insert check of 009 counts a negative tax amount as a
 *      negative line. The document's own tax amount stays non-negative (007).
 *   3. `historical_import_item`: the staging row of one uploaded PDF, a working
 *      table that stays mutable until its document is imported (status
 *      `uploaded`, `extracting`, `ready`, `needs_attention`, `imported`,
 *      `discarded`). It holds the bytes, their size and SHA-256, the extracted
 *      record, the user's corrected record KEYED to the extraction it corrects
 *      (`corrected_extraction_id`), the named problems, the claim time of a
 *      running extraction and, once imported, the document. When imported, the
 *      bytes are cleared (they live on in `sales_document_file`) and the row is
 *      frozen for every role (BK010). `number_confirmed` holds the printed number
 *      the user confirmed as right when it jumps far ahead (validate.ts); it
 *      counts only while it equals the current number. One live row per file and company: a
 *      partial unique index on the SHA-256 for every status but `discarded`, so
 *      a discarded file can be staged again.
 *   4. `historical_import_extraction`: one row per model call (started,
 *      finished, model, outcome, token counts), the durable ledger the daily
 *      per-company ceiling counts and the record of what was spent. A row is
 *      finished once and never deleted (BK010, and the house REVOKE).
 *
 * House style as 007 to 009: BARE names, ids TEXT minted by the application,
 * trigger functions `SET search_path FROM CURRENT`, custom SQLSTATEs.
 */

export const booksUploadImport: Migration = {
  id: '010_books_upload_import',
  up: async (tx) => {
    // Change 1: an import may carry a printed number without a number value.
    await tx`ALTER TABLE "sales_document" DROP CONSTRAINT IF EXISTS "sales_document_issued_complete_check"`;
    await tx`
      ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_issued_complete_check" CHECK (
        "status" = 'draft' OR (
          "document_number" IS NOT NULL AND "number_value" IS NOT NULL AND "issue_date" IS NOT NULL
          AND "issued_at" IS NOT NULL AND "customer_id" IS NOT NULL AND "customer_snapshot" IS NOT NULL
          AND "sender_snapshot" IS NOT NULL AND "customer_type" IS NOT NULL AND "tax_profile_key" IS NOT NULL
        ) OR (
          "source" = 'import' AND "document_number" IS NOT NULL
          AND "issue_date" IS NOT NULL AND "issued_at" IS NOT NULL
          AND "customer_snapshot" IS NOT NULL AND "sender_snapshot" IS NOT NULL
        )
      )
    `;

    // Change 2: negative tax amounts on import discount lines, by the guards.
    await tx`ALTER TABLE "sales_document_line" DROP CONSTRAINT IF EXISTS "sales_document_line_tax_amount_check"`;
    // The document guard of 009, its negative-line insert check counting a negative tax amount.
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
          line_count BIGINT;
          corrected_currency TEXT;
      BEGIN
          IF TG_OP = 'DELETE' THEN
              RAISE EXCEPTION 'sales_document % cannot be deleted', OLD."id"
                  USING ERRCODE = 'BK001';
          END IF;

          -- Change 5, on every insert and update: a credit note carries its
          -- invoice's currency; any other currency than EUR only on an import.
          IF NEW."doc_type" = 'credit_note' AND NEW."corrects_document_id" IS NOT NULL THEN
              SELECT "currency_code" INTO corrected_currency
                FROM "sales_document"
               WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."corrects_document_id";
              IF FOUND AND NEW."currency_code" IS DISTINCT FROM corrected_currency THEN
                  RAISE EXCEPTION 'sales_document %: a credit note carries the currency of the invoice it corrects', NEW."id"
                      USING ERRCODE = 'BK009';
              END IF;
          ELSIF NEW."currency_code" <> 'EUR' AND NEW."source" <> 'import' THEN
              RAISE EXCEPTION 'sales_document %: a currency other than EUR is only kept on an imported document', NEW."id"
                  USING ERRCODE = 'BK009';
          END IF;

          IF TG_OP = 'INSERT' THEN
              -- A document is born a draft; only the historical import inserts
              -- documents that are already issued (with their number and
              -- snapshots, which the CHECKs enforce).
              IF NEW."status" <> 'draft' AND NEW."source" <> 'import' THEN
                  RAISE EXCEPTION 'sales_document %: a document is created as a draft (got %)', NEW."id", NEW."status"
                      USING ERRCODE = 'BK004';
              END IF;
              -- Negative lines written before their document (change 4) belong to an import only.
              IF NEW."source" <> 'import' AND EXISTS (
                  SELECT 1 FROM "sales_document_line"
                   WHERE "tenant_id" = NEW."tenant_id" AND "document_id" = NEW."id"
                     AND ("unit_price" < 0 OR "subtotal" < 0 OR "tax_amount" < 0)
              ) THEN
                  RAISE EXCEPTION 'sales_document %: a negative line amount is only allowed on an imported document', NEW."id"
                      USING ERRCODE = 'BK008';
              END IF;
              -- An issued import writes its lines first (009, the deferred line
              -- foreign key); they must already be there and sum to the totals.
              -- (An import claiming to be a draft is left to the CHECKs.)
              IF NEW."source" = 'import' AND NEW."status" <> 'draft' THEN
                  SELECT COALESCE(SUM("subtotal"), 0), COALESCE(SUM("tax_amount"), 0), COUNT(*)
                    INTO lines_subtotal, lines_tax, line_count
                    FROM "sales_document_line"
                   WHERE "tenant_id" = NEW."tenant_id" AND "document_id" = NEW."id";
                  IF line_count = 0 THEN
                      RAISE EXCEPTION 'sales_document %: an imported document carries its lines', NEW."id"
                          USING ERRCODE = 'BK005';
                  END IF;
                  IF lines_subtotal <> NEW."subtotal" OR lines_tax <> NEW."tax_amount" THEN
                      RAISE EXCEPTION 'sales_document %: totals (%, %) do not equal the lines (%, %)',
                          NEW."id", NEW."subtotal", NEW."tax_amount", lines_subtotal, lines_tax
                          USING ERRCODE = 'BK005';
                  END IF;
              END IF;
              RETURN NEW;
          END IF;

          -- The identity of a document never changes, not even on a draft: a draft
          -- cannot become an import, change its type or move to another company,
          -- and (009) a credit note cannot be re-pointed to another invoice (its
          -- currency and its copied lines follow the invoice it was created for).
          IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
             OR NEW."doc_type" IS DISTINCT FROM OLD."doc_type" OR NEW."source" IS DISTINCT FROM OLD."source"
             OR NEW."corrects_document_id" IS DISTINCT FROM OLD."corrects_document_id" THEN
              RAISE EXCEPTION 'sales_document %: id, tenant_id, doc_type, source and corrects_document_id are fixed', OLD."id"
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
    // The line guard of 009, a negative tax amount counted like a negative amount, copies compared with rate and tax.
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_line_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          parent_status "SalesDocStatus";
          parent_type "SalesDocType";
          parent_corrects TEXT;
      BEGIN
          IF TG_OP IN ('INSERT', 'UPDATE') THEN
              SELECT "status", "doc_type", "corrects_document_id"
                INTO parent_status, parent_type, parent_corrects
                FROM "sales_document"
               WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."document_id"
                 FOR SHARE;
              IF FOUND AND parent_status <> 'draft' THEN
                  RAISE EXCEPTION 'sales_document % is not a draft (status %): its lines are frozen',
                      NEW."document_id", parent_status
                      USING ERRCODE = 'BK001';
              END IF;
              -- A negative amount (a printed discount line): only while the parent
              -- does not exist yet (the import writes its lines first; the
              -- document's insert then requires source = 'import'), or on the
              -- draft credit note cancelling an imported invoice, as the exact
              -- copy of one of that invoice's lines (position and amounts).
              IF (NEW."unit_price" < 0 OR NEW."subtotal" < 0 OR NEW."tax_amount" < 0) AND FOUND AND NOT (
                  parent_type = 'credit_note' AND EXISTS (
                      SELECT 1
                        FROM "sales_document" o
                        JOIN "sales_document_line" ol
                          ON ol."tenant_id" = o."tenant_id" AND ol."document_id" = o."id"
                       WHERE o."tenant_id" = NEW."tenant_id" AND o."id" = parent_corrects AND o."source" = 'import'
                         AND ol."position" = NEW."position" AND ol."quantity" = NEW."quantity"
                         AND ol."unit_price" = NEW."unit_price" AND ol."subtotal" = NEW."subtotal"
                         AND ol."tax_rate" = NEW."tax_rate" AND ol."tax_amount" = NEW."tax_amount"
                  )
              ) THEN
                  RAISE EXCEPTION 'sales_document_line: a negative amount is only allowed on an imported document'
                      USING ERRCODE = 'BK008';
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

    // Change 3: the staging row of one uploaded PDF.
    await tx`
      CREATE TABLE IF NOT EXISTS "historical_import_item" (
        "id" TEXT NOT NULL,
        "tenant_id" TEXT NOT NULL,
        "file_name" TEXT NOT NULL,
        "content" BYTEA,
        "byte_size" INTEGER NOT NULL,
        "sha256" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'uploaded',
        "version" INTEGER NOT NULL DEFAULT 0,
        "extraction_id" TEXT,
        "extracted" JSONB,
        "extraction_error" TEXT,
        "corrected" JSONB,
        "corrected_extraction_id" TEXT,
        "number_confirmed" TEXT,
        "problems" JSONB NOT NULL DEFAULT '[]',
        "model" TEXT,
        "claimed_at" TIMESTAMP(3),
        "claim_id" TEXT,
        "document_id" TEXT,
        "discarded_at" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "historical_import_item_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "historical_import_item_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "historical_import_item_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "historical_import_item_file_name_check" CHECK (length("file_name") BETWEEN 1 AND 255),
        CONSTRAINT "historical_import_item_size_check" CHECK (
          "byte_size" > 0 AND ("content" IS NULL OR "byte_size" = octet_length("content"))
        ),
        CONSTRAINT "historical_import_item_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "historical_import_item_status_check" CHECK (
          "status" IN ('uploaded', 'extracting', 'ready', 'needs_attention', 'imported', 'discarded')
        ),
        -- The bytes stay until the file is imported (then they live in
        -- sales_document_file) or discarded (cleared after 30 days).
        CONSTRAINT "historical_import_item_content_check" CHECK (
          "content" IS NOT NULL OR "status" IN ('imported', 'discarded')
        ),
        CONSTRAINT "historical_import_item_imported_check" CHECK (
          ("status" = 'imported') = ("document_id" IS NOT NULL)
          AND ("status" <> 'imported' OR "content" IS NULL)
        ),
        CONSTRAINT "historical_import_item_discarded_check" CHECK (("status" = 'discarded') = ("discarded_at" IS NOT NULL)),
        CONSTRAINT "historical_import_item_extracted_check" CHECK ("extracted" IS NULL OR jsonb_typeof("extracted") = 'object'),
        CONSTRAINT "historical_import_item_corrected_check" CHECK (
          ("corrected" IS NULL OR jsonb_typeof("corrected") = 'object')
          AND (("corrected" IS NULL) = ("corrected_extraction_id" IS NULL))
        ),
        CONSTRAINT "historical_import_item_problems_check" CHECK (jsonb_typeof("problems") = 'array'),
        CONSTRAINT "historical_import_item_document_fkey" FOREIGN KEY ("tenant_id", "document_id")
          REFERENCES "sales_document" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "historical_import_item_live_sha256_key"
        ON "historical_import_item" ("tenant_id", "sha256")
        WHERE "status" <> 'discarded'
    `;
    await tx`CREATE INDEX IF NOT EXISTS "historical_import_item_tenant_status_idx" ON "historical_import_item" ("tenant_id", "status", "created_at")`;

    await tx`
      CREATE OR REPLACE FUNCTION "historical_import_item_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF TG_OP = 'TRUNCATE' THEN
              RAISE EXCEPTION 'historical_import_item cannot be truncated'
                  USING ERRCODE = 'BK010';
          END IF;
          IF OLD."status" = 'imported' THEN
              RAISE EXCEPTION 'historical_import_item %: an imported item is frozen (% refused)', OLD."id", TG_OP
                  USING ERRCODE = 'BK010';
          END IF;
          IF TG_OP = 'DELETE' THEN
              RETURN OLD;
          END IF;
          IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
             OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
             OR NEW."file_name" IS DISTINCT FROM OLD."file_name" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
              RAISE EXCEPTION 'historical_import_item %: the file identity is fixed', OLD."id"
                  USING ERRCODE = 'BK010';
          END IF;
          -- The bytes are only ever cleared, never replaced.
          IF NEW."content" IS NOT NULL AND NEW."content" IS DISTINCT FROM OLD."content" THEN
              RAISE EXCEPTION 'historical_import_item %: the uploaded bytes are never replaced', OLD."id"
                  USING ERRCODE = 'BK010';
          END IF;
          -- Only a checked item is imported.
          IF NEW."status" = 'imported' AND OLD."status" <> 'ready' THEN
              RAISE EXCEPTION 'historical_import_item %: only a ready item is imported (was %)', OLD."id", OLD."status"
                  USING ERRCODE = 'BK010';
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "historical_import_item_guard" ON "historical_import_item"`;
    await tx`
      CREATE TRIGGER "historical_import_item_guard"
          BEFORE UPDATE OR DELETE ON "historical_import_item"
          FOR EACH ROW
          EXECUTE FUNCTION "historical_import_item_guard"()
    `;
    await tx`DROP TRIGGER IF EXISTS "historical_import_item_no_truncate" ON "historical_import_item"`;
    await tx`
      CREATE TRIGGER "historical_import_item_no_truncate"
          BEFORE TRUNCATE ON "historical_import_item"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "historical_import_item_guard"()
    `;

    // Change 4: the extraction ledger.
    await tx`
      CREATE TABLE IF NOT EXISTS "historical_import_extraction" (
        "id" TEXT NOT NULL,
        "tenant_id" TEXT NOT NULL,
        "item_id" TEXT NOT NULL,
        "model" TEXT NOT NULL,
        "started_at" TIMESTAMP(3) NOT NULL,
        "finished_at" TIMESTAMP(3),
        "outcome" TEXT,
        "input_tokens" INTEGER NOT NULL DEFAULT 0,
        "output_tokens" INTEGER NOT NULL DEFAULT 0,

        CONSTRAINT "historical_import_extraction_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "historical_import_extraction_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
        CONSTRAINT "historical_import_extraction_model_check" CHECK (length("model") BETWEEN 1 AND 100),
        CONSTRAINT "historical_import_extraction_outcome_check" CHECK (
          ("outcome" IS NULL) = ("finished_at" IS NULL)
          AND ("outcome" IS NULL OR "outcome" IN ('ok', 'refused', 'invalid_output', 'max_tokens', 'unreadable', 'error', 'aborted'))
        ),
        CONSTRAINT "historical_import_extraction_tokens_check" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0),
        CONSTRAINT "historical_import_extraction_item_fkey" FOREIGN KEY ("tenant_id", "item_id")
          REFERENCES "historical_import_item" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;
    await tx`CREATE INDEX IF NOT EXISTS "historical_import_extraction_tenant_started_idx" ON "historical_import_extraction" ("tenant_id", "started_at")`;
    await tx`CREATE INDEX IF NOT EXISTS "historical_import_extraction_item_idx" ON "historical_import_extraction" ("tenant_id", "item_id")`;
    await tx`
      CREATE OR REPLACE FUNCTION "historical_import_extraction_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
              RAISE EXCEPTION 'historical_import_extraction is a ledger (% refused)', TG_OP
                  USING ERRCODE = 'BK010';
          END IF;
          -- A started call is finished once: only the finish fields change, once.
          IF OLD."finished_at" IS NOT NULL
             OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
             OR NEW."item_id" IS DISTINCT FROM OLD."item_id" OR NEW."model" IS DISTINCT FROM OLD."model"
             OR NEW."started_at" IS DISTINCT FROM OLD."started_at" THEN
              RAISE EXCEPTION 'historical_import_extraction %: a call is finished once and never rewritten', OLD."id"
                  USING ERRCODE = 'BK010';
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "historical_import_extraction_guard" ON "historical_import_extraction"`;
    await tx`
      CREATE TRIGGER "historical_import_extraction_guard"
          BEFORE UPDATE OR DELETE ON "historical_import_extraction"
          FOR EACH ROW
          EXECUTE FUNCTION "historical_import_extraction_guard"()
    `;
    await tx`DROP TRIGGER IF EXISTS "historical_import_extraction_no_truncate" ON "historical_import_extraction"`;
    await tx`
      CREATE TRIGGER "historical_import_extraction_no_truncate"
          BEFORE TRUNCATE ON "historical_import_extraction"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "historical_import_extraction_guard"()
    `;

    // The house REVOKE (re-applied after the provisioning grants through
    // NO_DELETE_TABLES): neither a staging row nor a ledger row is deleted by
    // the app role. Guarded on role existence, as in 007.
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE DELETE, TRUNCATE ON "historical_import_item" FROM commerce_app;
          REVOKE DELETE, TRUNCATE ON "historical_import_extraction" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
