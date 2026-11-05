import type { Migration } from '@marlinjai/tenant-db';

/**
 * Company erasure, `029_company_erasure`: the one sanctioned way past the delete guards, used only when
 * auth-brain erases a company (`tenant.erased`, src/server/erasure, plan
 * docs/plans/2026-11-05-company-erasure-consumer.md). Every guard keeps refusing every other DELETE exactly
 * as before; INSERT and UPDATE are untouched.
 *
 * Why a way past them is needed: a tenant group's schema is SHARED by every company of the group, so an
 * erased company cannot be removed by dropping the schema. Its rows are deleted one company at a time, and
 * the Books and payment tables refuse deletes on purpose (an issued invoice, its lines, events and stored
 * PDF, the number counters, the template versions, imported originals, payments and their provider events).
 * Erasing the company overrides that immutability deliberately: the company itself asked to be deleted, and
 * keeping its invoices is its own duty under its own retention rules, not the platform's after the account
 * is gone (the plan says so, and the company is told to export first).
 *
 * The structural guarantees, and why each exists:
 *
 *   1. `company_erasure_allows(tenant_id)` is true only when BOTH hold:
 *        - the transaction-local setting `lumitra.erasing_company` names exactly that company id (the erasure
 *          sets it with `set_config(..., true)`, so it ends with the transaction), and
 *        - the current role is a member of the role that owns this schema (`commerce_ddl` in production).
 *      The second condition is what makes it safe: any role may set a custom setting, so the low-privilege
 *      app role (`commerce_app`) setting it gets nothing. Only the owner connection
 *      (COMMERCE_OWNER_DATABASE_URL) can erase. A superuser is a member of every role, as always.
 *   2. Each guard that fires on DELETE is split in two triggers: the original name for its other events
 *      (UPDATE, INSERT) with the original function, and `<name>_delete`, BEFORE DELETE FOR EACH ROW
 *      WHEN (NOT company_erasure_allows(OLD.tenant_id)), with the same function. Recreating triggers instead of
 *      copying function bodies keeps every refusal exactly as the earlier migrations wrote it, including
 *      function bodies a later migration redefines. `sales_document_draft_delete` fires on DELETE only and
 *      keeps its name with the condition added; while erasing, its own deletes of a draft's lines and events
 *      are skipped, and the erasure deletes them itself.
 *   3. TRUNCATE stays refused for everyone (the statement triggers are not touched): the erasure deletes one
 *      company's rows, never a whole table of a shared schema.
 *   4. The erasure refuses to run on a schema without this migration (it checks `__tenant_db_migrations`),
 *      so a schema the fleet migration has not reached yet fails loudly and the delivery is retried.
 *
 * A test (src/server/erasure/__tests__/companyErasure.itest.ts) fails on any row trigger that fires on
 * DELETE in a provisioned schema and is neither guarded by this condition nor listed as harmless, so a
 * future guard cannot be forgotten.
 *
 * House style as 007 to 028: BARE names, functions `SET search_path FROM CURRENT`. Re-runnable: CREATE OR
 * REPLACE and DROP TRIGGER IF EXISTS before each CREATE TRIGGER.
 */

/** The setting the erasure names the company with (transaction-local). */
export const ERASING_COMPANY_SETTING = 'lumitra.erasing_company';

/**
 * Every guard trigger that refuses a DELETE: [trigger, table, function, the events it keeps besides DELETE
 * (null when it fires on DELETE only)].
 */
export const ERASURE_GUARDED_TRIGGERS: ReadonlyArray<readonly [string, string, string, string | null]> = [
  ['books_asset_guard', 'books_asset', 'books_asset_guard', 'UPDATE'],
  ['document_number_counter_monotonic', 'document_number_counter', 'document_number_counter_monotonic', 'UPDATE'],
  ['document_template_version_guard', 'document_template_version', 'document_template_version_guard', 'UPDATE'],
  ['historical_import_extraction_guard', 'historical_import_extraction', 'historical_import_extraction_guard', 'UPDATE'],
  ['historical_import_item_guard', 'historical_import_item', 'historical_import_item_guard', 'UPDATE'],
  ['order_payment_guard', 'order_payment', 'order_payment_guard', 'INSERT OR UPDATE'],
  ['payment_event_append_only', 'payment_event', 'payment_event_append_only', 'UPDATE'],
  ['sales_document_draft_delete', 'sales_document', 'sales_document_draft_delete', null],
  ['sales_document_event_append_only', 'sales_document_event', 'sales_document_event_append_only', 'UPDATE'],
  ['sales_document_file_guard', 'sales_document_file', 'sales_document_file_guard', 'INSERT OR UPDATE'],
  ['sales_document_line_guard', 'sales_document_line', 'sales_document_line_guard', 'INSERT OR UPDATE'],
];

export const companyErasure: Migration = {
  id: '029_company_erasure',
  up: async (tx) => {
    await tx.unsafe(`
      CREATE OR REPLACE FUNCTION "company_erasure_allows"(company TEXT) RETURNS BOOLEAN
          LANGUAGE sql STABLE
          SET search_path FROM CURRENT
      AS $fn$
          SELECT company IS NOT NULL
             AND current_setting('${ERASING_COMPANY_SETTING}', true) IS NOT DISTINCT FROM company
             AND pg_has_role(current_user, (SELECT nspowner FROM pg_namespace WHERE nspname = current_schema()), 'MEMBER')
      $fn$
    `);
    for (const [trigger, table, fn, others] of ERASURE_GUARDED_TRIGGERS) {
      await tx.unsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`);
      await tx.unsafe(`DROP TRIGGER IF EXISTS "${trigger}_delete" ON "${table}"`);
      if (others === null) {
        await tx.unsafe(`
          CREATE TRIGGER "${trigger}" BEFORE DELETE ON "${table}"
              FOR EACH ROW WHEN (NOT "company_erasure_allows"(OLD."tenant_id")) EXECUTE FUNCTION "${fn}"()
        `);
      } else {
        await tx.unsafe(`CREATE TRIGGER "${trigger}" BEFORE ${others} ON "${table}" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
        await tx.unsafe(`
          CREATE TRIGGER "${trigger}_delete" BEFORE DELETE ON "${table}"
              FOR EACH ROW WHEN (NOT "company_erasure_allows"(OLD."tenant_id")) EXECUTE FUNCTION "${fn}"()
        `);
      }
    }
  },
};
