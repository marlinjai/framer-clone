// src/server/commerce/migrations/tenant/011_books_replacement.ts
//
// 011_books_replacement: the Correct flow of the Books (plan
// docs/plans/2026-10-21-books-visual-template-composer.md, decision 9 and
// phase 1). "Korrigieren" on an issued invoice creates a replacement DRAFT
// that points at the invoice it replaces; issuing that draft cancels the old
// invoice through a credit note and issues the replacement, in one
// transaction. This migration adds the link and the guarantees around it.
import type { Migration } from '@marlinjai/tenant-db';

/*
 * The changes, and why each exists:
 *
 *   1. `sales_document.replaces_document_id`: the invoice a replacement
 *      replaces. Composite foreign key (tenant_id, replaces_document_id) ->
 *      sales_document (tenant_id, id), so it can never point at another
 *      company's document. A CHECK allows it on invoices only and never on the
 *      document itself. Like every column it may change while the document is
 *      a draft (the user can turn a replacement into an ordinary invoice) and
 *      is frozen with the rest of the row once issued (007's guard compares
 *      the whole row).
 *   2. One replacement per invoice: a partial UNIQUE index on
 *      (tenant_id, replaces_document_id). A second "Korrigieren" finds and
 *      reopens the existing draft; a race of two clicks loses on the index.
 *   3. What may be replaced (BK011, on INSERT and on UPDATE of the column):
 *      an invoice made in the editor that is issued (any status after draft).
 *      Imported invoices keep plain cancellation (an import may be in CHF or
 *      carry an incomplete printed address, so a copied draft could not be
 *      issued; plan decision 9).
 *   4. A replacement is issued only together with the cancellation of the
 *      invoice it replaces (BK011): a deferred constraint trigger checks at
 *      commit that a non-draft replacement's invoice is cancelled. So a
 *      replacement can never stand beside a still valid original.
 *
 * House style as 007: BARE names, trigger functions `SET search_path FROM
 * CURRENT`. Like all of 007's invariants, the triggers bind every role
 * including the owner (not a session that disables triggers, which only a
 * superuser can set and the application never does).
 */

export const booksReplacement: Migration = {
  id: '011_books_replacement',
  up: async (tx) => {
    // Change 1: the link.
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "replaces_document_id" TEXT`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'sales_document_replaces_check'
             AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_replaces_check"
            CHECK (
              "replaces_document_id" IS NULL
              OR ("doc_type" = 'invoice' AND "replaces_document_id" <> "id")
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'sales_document_replaces_document_fkey'
             AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_replaces_document_fkey"
            FOREIGN KEY ("tenant_id", "replaces_document_id")
            REFERENCES "sales_document" ("tenant_id", "id")
            ON DELETE RESTRICT ON UPDATE RESTRICT;
        END IF;
      END
      $$
    `;

    // Change 2: one replacement per invoice.
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "sales_document_replaces_key"
          ON "sales_document" ("tenant_id", "replaces_document_id")
          WHERE "replaces_document_id" IS NOT NULL
    `;

    // Change 3: what may be replaced.
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_replaces_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          target RECORD;
      BEGIN
          IF NEW."replaces_document_id" IS NULL THEN
              RETURN NEW;
          END IF;
          IF TG_OP = 'UPDATE' AND NEW."replaces_document_id" IS NOT DISTINCT FROM OLD."replaces_document_id" THEN
              RETURN NEW;
          END IF;
          SELECT "doc_type", "source", "status" INTO target
            FROM "sales_document"
           WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."replaces_document_id";
          -- A missing target is the foreign key's to refuse.
          IF FOUND AND (target."doc_type" <> 'invoice' OR target."source" <> 'editor' OR target."status" = 'draft') THEN
              RAISE EXCEPTION 'sales_document %: only an issued invoice made in the editor can be replaced', NEW."id"
                  USING ERRCODE = 'BK011';
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_replaces_guard" ON "sales_document"`;
    await tx`
      CREATE TRIGGER "sales_document_replaces_guard"
          BEFORE INSERT OR UPDATE OF "replaces_document_id" ON "sales_document"
          FOR EACH ROW
          EXECUTE FUNCTION "sales_document_replaces_guard"()
    `;

    // Change 4: a replacement is issued only with the cancellation of its invoice.
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_replacement_complete"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          -- Re-read the row as it stands at commit (the trigger fired for an
          -- earlier version of it).
          IF EXISTS (
              SELECT 1
                FROM "sales_document" d
                JOIN "sales_document" o
                  ON o."tenant_id" = d."tenant_id" AND o."id" = d."replaces_document_id"
               WHERE d."tenant_id" = NEW."tenant_id" AND d."id" = NEW."id"
                 AND d."status" <> 'draft'
                 AND o."status" <> 'cancelled'
          ) THEN
              RAISE EXCEPTION 'sales_document %: a replacement is issued only together with the cancellation of the invoice it replaces', NEW."id"
                  USING ERRCODE = 'BK011';
          END IF;
          RETURN NULL;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_replacement_complete" ON "sales_document"`;
    await tx`
      CREATE CONSTRAINT TRIGGER "sales_document_replacement_complete"
          AFTER INSERT OR UPDATE ON "sales_document"
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          WHEN (NEW."replaces_document_id" IS NOT NULL AND NEW."status" <> 'draft')
          EXECUTE FUNCTION "sales_document_replacement_complete"()
    `;
  },
};
