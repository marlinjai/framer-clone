import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books sender contact, `033_books_sender_contact`: which organization of the shared contacts database a
 * company issues its documents as (docs/plans/2026-11-26-books-sender-from-contacts.md). Purely additive: one
 * nullable column.
 *
 *   1. Nullable, no default, no backfill. NULL means what it always meant: the sender is `sender_block`. A build
 *      that predates the column ignores it, so redeploying it is the rollback. Issued documents print their own
 *      `sender_snapshot` and are not touched.
 *   2. No foreign key: the contact lives in another database. A pointer to a contact that was erased, merged away
 *      or archived is refused by the application (src/server/books/sender.ts), never papered over with the block.
 *   3. A contact id has the shape of a uuid (a CHECK), so nothing else is ever stored.
 *   4. A bounded lock wait, as 030.
 */
const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

export const booksSenderContact: Migration = {
  id: '033_books_sender_contact',
  up: async (tx) => {
    await tx`SET LOCAL lock_timeout = '5000ms'`;
    await tx`ALTER TABLE "books_company_settings" ADD COLUMN IF NOT EXISTS "sender_contact_id" TEXT`;
    await tx.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'books_company_settings_sender_contact_id_check'
            AND conrelid = 'books_company_settings'::regclass
        ) THEN
          ALTER TABLE "books_company_settings" ADD CONSTRAINT "books_company_settings_sender_contact_id_check"
            CHECK ("sender_contact_id" IS NULL OR "sender_contact_id" ~ ${UUID});
        END IF;
      END
      $$
    `);
  },
};
