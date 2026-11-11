import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books contact person, `030_books_contact_person`: the person at a business customer an invoice is
 * addressed to ("z. Hd."), and the customer's default one (plan docs/plans/2026-11-11-contact-affiliations.md in
 * the contacts repository, section 6). Purely additive: two nullable columns.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. Nullable, no default, no backfill. Every existing customer and document, issued ones included, reads
 *      NULL: no contact person, a re-render of an issued invoice draws exactly what it drew before. Adding a
 *      column is DDL, no row is updated, so the freeze guard of 007 (whole-row `to_jsonb` comparison) never sees
 *      a change, and from now on freezes `contact_person_id` of an issued document like every other column with
 *      no new trigger code. What an issued invoice prints is its snapshot (`customer_snapshot`, version 2),
 *      not this column.
 *   2. No foreign key: the person is a contact of the shared contacts database, another database. A pointer to
 *      a person who has since left or been erased is handled by the application (the draft shows it as
 *      unavailable, issue refuses), never by this schema.
 *   3. A contact id has the shape of a uuid (a CHECK), so nothing else is ever stored.
 *   4. A bounded lock wait, as 016: the ALTERs give up after 5 s rather than queue every query behind them.
 */
const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

export const booksContactPerson: Migration = {
  id: '030_books_contact_person',
  up: async (tx) => {
    await tx`SET LOCAL lock_timeout = '5000ms'`;
    await tx`ALTER TABLE "customer" ADD COLUMN IF NOT EXISTS "default_contact_person_id" TEXT`;
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "contact_person_id" TEXT`;
    for (const [table, column] of [
      ['customer', 'default_contact_person_id'],
      ['sales_document', 'contact_person_id'],
    ] as const) {
      const name = `${table}_${column}_check`;
      await tx.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = '${table}'::regclass
          ) THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}"
              CHECK ("${column}" IS NULL OR "${column}" ~ ${UUID});
          END IF;
        END
        $$
      `);
    }
  },
};
