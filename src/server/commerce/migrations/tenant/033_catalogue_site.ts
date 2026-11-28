import type { Migration } from '@marlinjai/tenant-db';

/**
 * The shop catalogue per project, `033_catalogue_site` (docs/plans/2026-11-27-agent-catalogue-tools.md, decided by
 * Marlin on 2026-11-28: products, variants, prices, stock and collections belong to a site, not to the company).
 * Purely additive: two nullable columns, one table, and two handle indexes widened to the site. No row is moved
 * here: the tenant schema cannot see which sites a company has (they live in `public`), so the assignment is an
 * operator step with a dry run (`pnpm catalogue:assign-sites`, src/server/commerce/provisioning/assignSites.ts).
 *
 *   1. `product.site_id` and `collection.site_id`: the main site the row belongs to. TEXT without a foreign key,
 *      as `order.site_id` and `product_site_hidden.site_id` (020 guarantee 9): sites live in the public schema
 *      and each tenant schema stays self-contained. NULL means one of two things, told apart by guarantee 2.
 *   2. `catalogue_per_site` (one row per company): the company's catalogue has been assigned to its sites. For
 *      such a company a NULL `site_id` is a company item (sold through the Books, on no site); for a company
 *      without the row, a NULL `site_id` is a row from before the assignment, and the shop still reads it the
 *      old way (the company's products not switched off for the site in `product_site_hidden`). So a deploy
 *      changes no live shop until the assignment runs, and the assignment switches one company at a time.
 *   3. Handles unique per company AND site among live rows: the same "ring" may be sold on two sites of one
 *      company as two products. Company items (NULL site) share one handle space, the old per-company rule.
 *      SKU and barcode stay unique per tenant group (the stock ledger is keyed by SKU), so a product on a
 *      second site carries its own SKU and its own stock.
 *
 * `product_site_hidden` stays: it is the assignment's input and the read rule of companies not yet assigned. A
 * later migration drops it once every company is assigned.
 *
 * House style as 020: BARE names. Re-runnable.
 */
export const catalogueSite: Migration = {
  id: '033_catalogue_site',
  up: async (tx) => {
    for (const table of ['product', 'collection'] as const) {
      await tx`ALTER TABLE ${tx(table)} ADD COLUMN IF NOT EXISTS "site_id" TEXT`;
      await tx.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_site_id_check' AND conrelid = '"${table}"'::regclass) THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${table}_site_id_check" CHECK ("site_id" IS NULL OR length("site_id") BETWEEN 1 AND 100);
          END IF;
        END
        $$
      `);
    }

    await tx`
      CREATE TABLE IF NOT EXISTS "catalogue_per_site" (
          "tenant_id"    TEXT         NOT NULL,
          "assigned_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "report"       JSONB        NOT NULL,
          CONSTRAINT "catalogue_per_site_pkey" PRIMARY KEY ("tenant_id"),
          CONSTRAINT "catalogue_per_site_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "catalogue_per_site_report_check" CHECK (jsonb_typeof("report") = 'object')
      )
    `;

    // Guarantee 3: handles per company and site. The new index is built before the old one goes, so a handle is
    // never unguarded; COALESCE puts every company item (NULL site) in one handle space.
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "product_tenant_site_handle_active_key"
        ON "product" ("tenant_id", (COALESCE("site_id", '')), "handle")
        WHERE "deleted_at" IS NULL
    `;
    await tx`DROP INDEX IF EXISTS "product_tenant_handle_active_key"`;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "collection_tenant_site_handle_live_key"
        ON "collection" ("tenant_id", (COALESCE("site_id", '')), "handle")
        WHERE "archived_at" IS NULL
    `;
    await tx`DROP INDEX IF EXISTS "collection_tenant_handle_live_key"`;

    // The shop reads a site's products and collections by company and site.
    await tx`CREATE INDEX IF NOT EXISTS "product_tenant_site_idx" ON "product" ("tenant_id", "site_id")`;
    await tx`CREATE INDEX IF NOT EXISTS "collection_tenant_site_idx" ON "collection" ("tenant_id", "site_id")`;
  },
};
