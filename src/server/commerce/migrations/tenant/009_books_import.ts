import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books, `009_books_import`: what the historical import of the invoices issued
 * before the Books existed needs from the schema, and nothing more. Specified in
 * docs/plans/2026-08-15-books-receipts-invoices-integration.md, "Historical
 * import build notes (2026-10-20)". 007 and 008 are deployed and never edited;
 * this migration changes them forward.
 *
 * The problem it solves: an imported invoice is born issued (007 lets only
 * `source = 'import'` do that), and the line guard refuses a line whose parent
 * document exists and is not a draft. Inserting the lines first was impossible
 * too, because the line's foreign key to its document was checked immediately.
 * An imported invoice could therefore never carry its lines.
 *
 * The changes, and why each exists:
 *
 *   1. `sales_document_line_document_fkey` becomes DEFERRABLE INITIALLY
 *      IMMEDIATE. Nothing changes for any existing writer (the check still runs
 *      per statement); the import transaction alone says
 *      `SET CONSTRAINTS sales_document_line_document_fkey DEFERRED`, writes the
 *      lines first (their parent does not exist yet, which the line guard leaves
 *      to the foreign key) and then the issued document. At commit the foreign
 *      key is checked as always. Once committed, a line can never be added to an
 *      imported document: the parent exists and is not a draft (BK001).
 *   2. The document guard, on the INSERT of an import, requires the lines that
 *      are already written to sum exactly to the document's subtotal and tax
 *      (BK005, the check `draft -> issued` makes for editor documents, which an
 *      import never passes through), and at least one line.
 *   3. A deferred constraint trigger requires every imported document, at
 *      commit, to point at its stored original (`rendered_pdf_file_id` set, and
 *      that file belonging to this very document) (BK007). An imported invoice
 *      without its document of record never commits, so the download can never
 *      fall back to rendering one.
 *   4. A printed discount line carries a NEGATIVE amount (the historical
 *      invoices print a discount as a line of its own, "Rabatt 10 %" with a
 *      minus amount). 007's static CHECKs (unit price and subtotal not
 *      negative) are replaced by the line guard, which allows a negative unit
 *      price or subtotal only on an imported document (its lines are written
 *      before it exists, and the document's insert then requires
 *      `source = 'import'`) and on the draft credit note that cancels an
 *      imported invoice (it copies the lines). Everywhere else a negative line
 *      is refused as before (BK008, mapped to INVALID_LINE). The document totals
 *      stay non-negative (007's CHECKs, untouched).
 *   (Like 007's freeze, rules 2, 4 and 5 live in triggers, which bind every
 *   role including the owner; like all of 007's invariants they do not hold
 *   for a session that disables triggers, `session_replication_role = replica`,
 *   which only a superuser can set and the application never does.)
 *   5. An imported document keeps the currency it was printed in (one historical
 *      invoice is in CHF): 007's `currency_code = 'EUR'` CHECK becomes a shape
 *      CHECK (three capital letters, ISO 4217), and the document guard allows a
 *      currency other than EUR only on an import, while a credit note always
 *      carries the currency of the invoice it corrects (so the one cancelling a
 *      CHF import is in CHF). Editor documents stay EUR only (BK009, mapped to
 *      CURRENCY_NOT_SUPPORTED). Amounts are never converted; the EUR value of a
 *      foreign-currency invoice belongs to the receipts app's income mirror.
 *
 * House style as 007: BARE names, trigger functions `SET search_path FROM
 * CURRENT`, custom SQLSTATEs.
 */

export const booksImport: Migration = {
  id: '009_books_import',
  up: async (tx) => {
    // Change 5 (structure): the currency is any ISO 4217 code by shape; the guard below decides where.
    await tx`ALTER TABLE "sales_document" DROP CONSTRAINT IF EXISTS "sales_document_currency_code_check"`;
    await tx`ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_currency_code_check" CHECK ("currency_code" ~ '^[A-Z]{3}$')`;

    // Change 1: the line's foreign key may be deferred by a transaction that asks.
    await tx`
      ALTER TABLE "sales_document_line"
        ALTER CONSTRAINT "sales_document_line_document_fkey" DEFERRABLE INITIALLY IMMEDIATE
    `;

    // Change 2: the document guard of 007, with the import INSERT branch
    // checking the lines written before it. Every other branch is unchanged.
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
                     AND ("unit_price" < 0 OR "subtotal" < 0)
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

    // Change 4: negative (discount) lines, on imports and their cancellations only.
    await tx`ALTER TABLE "sales_document_line" DROP CONSTRAINT IF EXISTS "sales_document_line_unit_price_check"`;
    await tx`ALTER TABLE "sales_document_line" DROP CONSTRAINT IF EXISTS "sales_document_line_subtotal_check"`;
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
              IF (NEW."unit_price" < 0 OR NEW."subtotal" < 0) AND FOUND AND NOT (
                  parent_type = 'credit_note' AND EXISTS (
                      SELECT 1
                        FROM "sales_document" o
                        JOIN "sales_document_line" ol
                          ON ol."tenant_id" = o."tenant_id" AND ol."document_id" = o."id"
                       WHERE o."tenant_id" = NEW."tenant_id" AND o."id" = parent_corrects AND o."source" = 'import'
                         AND ol."position" = NEW."position" AND ol."quantity" = NEW."quantity"
                         AND ol."unit_price" = NEW."unit_price" AND ol."subtotal" = NEW."subtotal"
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

    // Change 3: an imported document commits only together with its original.
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_import_complete"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1
                FROM "sales_document" d
                JOIN "sales_document_file" f
                  ON f."tenant_id" = d."tenant_id" AND f."id" = d."rendered_pdf_file_id"
               WHERE d."tenant_id" = NEW."tenant_id" AND d."id" = NEW."id"
                 AND f."document_id" = d."id"
          ) THEN
              RAISE EXCEPTION 'sales_document %: an imported document commits only with its stored original', NEW."id"
                  USING ERRCODE = 'BK007';
          END IF;
          RETURN NULL;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_import_complete" ON "sales_document"`;
    await tx`
      CREATE CONSTRAINT TRIGGER "sales_document_import_complete"
          AFTER INSERT ON "sales_document"
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          WHEN (NEW."source" = 'import')
          EXECUTE FUNCTION "sales_document_import_complete"()
    `;
  },
};
