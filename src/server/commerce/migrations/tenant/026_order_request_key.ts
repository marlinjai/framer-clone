import type { Migration } from '@marlinjai/tenant-db';

/**
 * `026_order_request_key` (docs/plans/2026-11-02-shop-backbone.md, slice B0): the order's idempotency key belongs
 * to its company. `order_request_id_key` made `request_id` unique across the whole schema, and a schema holds every
 * company of a tenant group, so one company's key could collide with another's. `order_tenant_request_id_key` is
 * unique per company.
 *
 * Safe on live rows: the old index already made `request_id` unique, so every pair (tenant_id, request_id) is unique
 * too and the build cannot fail. A row with no company yet (020's legacy rows) has a NULL `tenant_id`, which never
 * conflicts; no company-scoped read reaches such a row, as for the rest of the unassigned rows.
 *
 * Locks. tenant-db runs a migration inside a transaction, so CONCURRENTLY is not available, and both locks are held
 * until this migration commits. CREATE UNIQUE INDEX takes SHARE on "order": reads carry on, a checkout waits for the
 * length of the build. DROP INDEX takes ACCESS EXCLUSIVE on "order", the last step, a moment before the commit: reads
 * wait for that moment too. The new index comes first, so the key is enforced throughout.
 *
 * Behind a long transaction these locks would wait, and every query on the table would queue behind them: give up
 * after 5 s instead (the boot's migration run fails loudly and the next run retries), as 016 does.
 *
 * Re-runnable: IF NOT EXISTS and IF EXISTS.
 *
 * Rollback, by hand, after the application is back on the previous image:
 *   DROP INDEX IF EXISTS "order_tenant_request_id_key";
 *   CREATE UNIQUE INDEX "order_request_id_key" ON "order" ("request_id");
 *   DELETE FROM "__tenant_db_migrations" WHERE "id" = '026_order_request_key';
 * The CREATE fails when two companies have used one key since, and then there is no way back to the old index
 * without changing a placed order, which is an immutable invoice: the previous image also runs on the new index.
 */
export const orderRequestKey: Migration = {
  id: '026_order_request_key',
  up: async (tx) => {
    await tx`SET LOCAL lock_timeout = '5000ms'`;
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "order_tenant_request_id_key" ON "order" ("tenant_id", "request_id")`;
    await tx`DROP INDEX IF EXISTS "order_request_id_key"`;
  },
};
