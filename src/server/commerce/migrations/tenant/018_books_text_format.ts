import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books invoice editor, phase 4, `018_books_text_format`: the formatting of a
 * document's intro and closing texts (bold, italic, bullet items, paragraphs),
 * decided by the owner on 2026-10-23 (docs/plans/2026-10-23-books-wysiwyg-
 * invoice-editor.md, "Decided by the owner", item 2). Purely additive: two
 * nullable JSONB columns.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. The plain text stays where it is. `intro_text` / `outro_text` keep the
 *      words; `intro_format` / `outro_format` hold the run model
 *      (src/server/books/render/richText.ts) and the application derives the
 *      plain text from it on every write, never the other way round. So the
 *      legal checks, the search and the check for characters a font cannot
 *      print read words, never formatting.
 *   2. Nullable, no default, no backfill. NULL means "print the plain text as
 *      before", so every existing document, issued ones included, re-renders
 *      exactly as it did. Adding the columns updates no row, so 007's freeze
 *      guard (whole-row comparison) never fires, and it freezes the formats of
 *      an issued document from now on with no new trigger code.
 *   3. A shape check (`sales_document_intro_format_check`,
 *      `sales_document_outro_format_check`): a JSON object of version 1, so a
 *      stray scalar or a later shape written by an older reader is refused by
 *      the database itself. The full shape is checked by the application's
 *      schema, which the row cannot express.
 *   4. A bounded lock wait (5 s), as 014 and 016: the ALTER never makes every
 *      query on sales_document queue behind a long transaction.
 */
export const booksTextFormat: Migration = {
  id: '018_books_text_format',
  up: async (tx) => {
    await tx`SET LOCAL lock_timeout = '5000ms'`;
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "intro_format" JSONB`;
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "outro_format" JSONB`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'sales_document_intro_format_check' AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_intro_format_check"
            CHECK ("intro_format" IS NULL OR (jsonb_typeof("intro_format") = 'object' AND "intro_format" ->> 'v' = '1'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'sales_document_outro_format_check' AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_outro_format_check"
            CHECK ("outro_format" IS NULL OR (jsonb_typeof("outro_format") = 'object' AND "outro_format" ->> 'v' = '1'));
        END IF;
      END
      $$
    `;
  },
};
