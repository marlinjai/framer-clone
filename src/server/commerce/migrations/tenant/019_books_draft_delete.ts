import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books, `019_books_draft_delete`: a draft that never received a number may be
 * deleted, together with its lines and its events (ROADMAP 3d, reversing
 * decision 8 of docs/plans/2026-08-15-books-receipts-invoices-integration.md
 * for drafts only). Issued documents stay undeletable, exactly as before.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. One statement deletes a draft: `DELETE FROM sales_document WHERE ...`.
 *      The new BEFORE DELETE trigger `sales_document_draft_delete` refuses
 *      anything but a draft without a number (BK001, as before), and refuses a
 *      draft that was issued once (BK016): an offer may go back from issued to
 *      draft while unsent (007), and such a draft consumed a number of its
 *      series and carries an `issued` event, so deleting it would leave a gap
 *      no one can explain. Every other draft consumed nothing (007: an
 *      abandoned draft consumes no number).
 *   2. The trigger removes the draft's lines and events itself, before the
 *      document row goes (every foreign key onto `sales_document` is RESTRICT,
 *      so the children must go first). It runs SECURITY DEFINER as the schema
 *      owner, because the app role holds no DELETE on `sales_document_event`
 *      (APPEND_ONLY_TABLES): the event table stays append-only for the app role,
 *      and the only way an event row ever disappears is with its draft.
 *   3. `sales_document_event_append_only` (BK002) lets a DELETE through only for
 *      the events of the one document the trigger above is deleting, named by a
 *      transaction-local setting the trigger sets and clears. Any other DELETE,
 *      UPDATE or TRUNCATE of an event is refused for every role, as before.
 *   4. Files: a draft never has a stored file (008, guarantee 3: only a
 *      non-draft document gets one), so there is nothing to remove; the trigger
 *      asserts it rather than assuming it.
 *   5. `sales_document_guard` (007, redefined by 009 and 010) keeps its body and
 *      fires on INSERT OR UPDATE only now; its DELETE branch is unreachable.
 *      Recreating the trigger instead of copying the function keeps every
 *      refusal of an insert or update exactly as 010 wrote it.
 *
 * House style as 007 to 018: BARE names, trigger functions
 * `SET search_path FROM CURRENT`, custom SQLSTATE BK016. Re-runnable.
 */
export const booksDraftDelete: Migration = {
  id: '019_books_draft_delete',
  up: async (tx) => {
    // Guarantee 5: the guard no longer sees deletes.
    await tx`DROP TRIGGER IF EXISTS "sales_document_guard" ON "sales_document"`;
    await tx`
      CREATE TRIGGER "sales_document_guard"
          BEFORE INSERT OR UPDATE ON "sales_document"
          FOR EACH ROW
          EXECUTE FUNCTION "sales_document_guard"()
    `;

    // Guarantee 3: an event goes only with the draft being deleted.
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_event_append_only"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF TG_OP = 'DELETE'
             AND current_setting('books.deleting_document', true) = OLD."tenant_id" || ':' || OLD."document_id" THEN
              RETURN OLD;
          END IF;
          RAISE EXCEPTION 'sales_document_event is append-only (% refused)', TG_OP
              USING ERRCODE = 'BK002';
      END;
      $$
    `;

    // Guarantees 1, 2 and 4.
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_draft_delete"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF OLD."status" <> 'draft' OR OLD."document_number" IS NOT NULL OR OLD."number_value" IS NOT NULL THEN
              RAISE EXCEPTION 'sales_document % cannot be deleted: only a draft without a number can', OLD."id"
                  USING ERRCODE = 'BK001';
          END IF;
          IF EXISTS (
              SELECT 1 FROM "sales_document_event"
               WHERE "tenant_id" = OLD."tenant_id" AND "document_id" = OLD."id" AND "event_type" = 'issued'
          ) THEN
              RAISE EXCEPTION 'sales_document % was issued once: its number is spent, it cannot be deleted', OLD."id"
                  USING ERRCODE = 'BK016';
          END IF;
          IF EXISTS (
              SELECT 1 FROM "sales_document_file"
               WHERE "tenant_id" = OLD."tenant_id" AND "document_id" = OLD."id"
          ) THEN
              RAISE EXCEPTION 'sales_document % has a stored file and cannot be deleted', OLD."id"
                  USING ERRCODE = 'BK001';
          END IF;

          PERFORM set_config('books.deleting_document', OLD."tenant_id" || ':' || OLD."id", true);
          DELETE FROM "sales_document_line" WHERE "tenant_id" = OLD."tenant_id" AND "document_id" = OLD."id";
          DELETE FROM "sales_document_event" WHERE "tenant_id" = OLD."tenant_id" AND "document_id" = OLD."id";
          PERFORM set_config('books.deleting_document', '', true);
          RETURN OLD;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_draft_delete" ON "sales_document"`;
    await tx`
      CREATE TRIGGER "sales_document_draft_delete"
          BEFORE DELETE ON "sales_document"
          FOR EACH ROW
          EXECUTE FUNCTION "sales_document_draft_delete"()
    `;
  },
};
