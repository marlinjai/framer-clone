import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books invoice editor, phase 4, `016_books_subject`: a document's subject
 * line ("Betreff", as sevdesk), printed where the template places its
 * `subject` block (docs/plans/2026-10-23-books-wysiwyg-invoice-editor.md,
 * "Constraints for phase 4"). Purely additive: one nullable column.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. Nullable, no default, no backfill. Every existing document, issued ones
 *      included, reads NULL and prints no subject, so a re-render of an issued
 *      invoice draws exactly what it drew before. Adding the column is DDL: no
 *      row is updated, so the freeze guard of 007 (which compares whole rows
 *      with `to_jsonb`) never sees a change, and from now on it freezes the
 *      subject of an issued document like every other column, with no new
 *      trigger code.
 *   2. A bounded lock wait: the ALTER waits at most 5 s for its lock, so a
 *      long transaction never makes every query on sales_document queue
 *      behind the migration.
 *   3. At most 200 characters (`sales_document_subject_length_check`), the
 *      same bound the application enforces: one printed line, never a
 *      paragraph smuggled into the heading.
 */
export const booksSubject: Migration = {
  id: '016_books_subject',
  up: async (tx) => {
    // The ALTER takes an exclusive lock on sales_document for a moment. Behind a long transaction it would wait,
    // and every query on the table would queue behind it: give up after 5 s instead (the boot's migration run fails
    // loudly and the next run retries), as 014 bounds its waiting delete.
    await tx`SET LOCAL lock_timeout = '5000ms'`;
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "subject" TEXT`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'sales_document_subject_length_check'
             AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_subject_length_check"
            CHECK ("subject" IS NULL OR char_length("subject") <= 200);
        END IF;
      END
      $$
    `;
  },
};
