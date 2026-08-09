// src/server/commerce/provisioning/backfill-demo.ts
//
// CM-12: the one-shot BACK-COMPAT backfill (plan §9). The pre-migration commerce
// data is a single physical `commerce` schema (the seeded demo, the one current
// commerce tenant). This module provisions that demo tenant-group's `tg_<demo>`
// schema and COPIES the current `commerce.<table>` rows into it, so the demo
// storefront renders + checks out identically once CM-10 flips the render path /
// routes onto `tg_<demo>`.
//
// It is ADDITIVE: the old `commerce` schema is NOT touched (CM-13 drops it, and
// only AFTER the demo verifies green on `tg_<demo>`). Both schemas coexist until
// then, so a deploy rollback re-points to the old constant path. This module does
// NOT delete anything.
//
// OWNER ROLE ONLY. The copy does cross-schema `INSERT ... SELECT` and writes the
// append-only tables (stock_movement / credit_note / credit_note_ref / order /
// order_line_item) that the low-privilege app role is REVOKEd from. So, exactly
// like public.ts / provision.ts, it opens a DIRECT OWNER postgres.js connection
// (`commerce_ddl`, COMMERCE_OWNER_DATABASE_URL) outside any pool and closes it in
// a `finally`, NEVER the app base singleton from db.ts.
//
// Correctness rules from §9, all enforced below:
//   1. FK-SAFE ORDER: a child table is never copied before its parent (see the
//      ordering notes on BACKFILL_TABLES).
//   2. NO GENERATED / TRIGGER COLUMNS: `inventory_level.available_quantity` is
//      `GENERATED ALWAYS` (auto-excluded by the `is_generated` filter) and
//      `product_variant.option_signature` is trigger-maintained (NOT a Postgres
//      generated column, so it is named explicitly in NEVER_COPY). Both REGENERATE
//      in the target: available_quantity recomputes from stocked-reserved, and
//      option_signature recomputes when the product_variant_option matrix rows are
//      copied (the AFTER trigger fires on those inserts). Copying either would
//      error (generated) or desync (trigger).
//   3. ENUM CASTS: each `tg_<id>` schema owns its OWN enum types, so enum columns
//      round-trip through text into the TARGET schema's type (see CopyColumn).
//   4. SEQUENCE ADVANCE: copied `order` rows keep their ORD-%06d order_numbers,
//      so the target's fresh `order_number_seq` is advanced past the highest
//      copied number, or the first post-flip `createOrderKysely` would draw a
//      colliding number (`order_number` is UNIQUE).
//   5. LEGACY RESTAMP: the demo Site / SitePage / SiteDomain / SiteExperiment
//      rows on existing deployments still carry the pre-CM-12 string id
//      'demo-tenant-group'; the tenant-db chokepoint validates a STRICT UUID, so
//      the CM-10 flip would 500 on them. The backfill restamps them to the
//      target tenant-group id.
//   6. COMPLETENESS: after provisioning, any table present in BOTH schemas but
//      missing from BACKFILL_TABLES throws (a new commerce table cannot be
//      silently dropped from the backfill).
//
// IDEMPOTENT. Provisioning is advisory-locked + a no-op when `tg_<demo>` already
// exists; the copy uses `ON CONFLICT DO NOTHING` so a re-run skips already-copied
// rows (on ANY unique / primary-key conflict) instead of double-inserting; the
// setval recomputes from the target's own rows; the restamp UPDATE matches zero
// rows on a re-run.

import postgres from 'postgres';
import { assertTenantGroupId, tenantSchema } from '@marlinjai/tenant-db';

import { provisionCommerceTenant } from './provision';

/**
 * The legacy single-tenant commerce schema (Prisma `@@schema("commerce")`) the
 * rows are copied FROM. Hardcoded (not imported from withTenant.ts) so this
 * transitional module carries no dependency on the seam CM-13 deletes.
 */
const SOURCE_SCHEMA = 'commerce';

/**
 * The pre-CM-12 demo tenant-group id: an arbitrary STRING sentinel stamped on
 * the public-schema sites-family rows by the old seed. It is NOT a UUID, so it
 * can never collide with a real tenant-group id, and it fails the tenant-db
 * chokepoint's strict-UUID validation (which is exactly why existing
 * deployments must be restamped, rule 5 above).
 */
const LEGACY_DEMO_TENANT_GROUP_ID = 'demo-tenant-group';

/**
 * The public-schema tables that carry a `tenant_group_id` column (the sites
 * family, prisma/schema.prisma `@@map` names). The restamp updates the legacy
 * sentinel on ALL of them.
 */
const RESTAMP_TABLES = ['sites', 'site_pages', 'site_domains', 'site_experiments'] as const;

/**
 * The commerce tables in FK-SAFE copy order (plan §9): a child table NEVER
 * precedes its parent, so an `INSERT ... SELECT` never violates a foreign key.
 * `"order"` is a reserved word; it is quoted at the SQL site below.
 *
 * Parent-before-child constraints encoded here (from the CM-04 migration set):
 *   - price_list BEFORE price (004: price.price_list_id -> price_list)
 *   - price_set BEFORE price; price BEFORE price_rule (004)
 *   - "order" BEFORE order_line_item AND BEFORE credit_note (005:
 *     order_line_item.order_id -> "order", credit_note.order_id -> "order")
 *   - credit_note BEFORE credit_note_ref (004)
 *   - product graph in dependency order (003); inventory ledger first (001/002)
 */
const BACKFILL_TABLES = [
  'inventory_item',
  'stock_location',
  'inventory_level',
  'stock_movement',
  'reservation',
  'product',
  'product_option',
  'product_option_value',
  'product_variant',
  'product_variant_option',
  'price_set',
  'price_list',
  'price',
  'price_rule',
  'order',
  'order_line_item',
  'credit_note',
  'credit_note_ref',
  'fulfillment_location_default',
] as const;

/**
 * Columns NEVER copied even when present in BOTH schemas: they REGENERATE in the
 * target. `available_quantity` is also caught by the `is_generated <> 'ALWAYS'`
 * filter (a Postgres generated column); `option_signature` is trigger-maintained,
 * so the catalog does not flag it and it MUST be named here.
 */
const NEVER_COPY = new Set(['available_quantity', 'option_signature']);

/**
 * Resolve the OWNER connection string at CALL TIME (not import), mirroring
 * provision.ts / public.ts: `next build` and module import never require a live
 * DB. Throws a clear, role-naming error when unset.
 */
function requireOwnerUrl(connectionString?: string): string {
  const ownerUrl = connectionString ?? process.env.COMMERCE_OWNER_DATABASE_URL;
  if (!ownerUrl) {
    throw new Error(
      'COMMERCE_OWNER_DATABASE_URL is not set. The demo backfill provisions a ' +
        'schema and does cross-schema INSERT...SELECT into append-only tables, so ' +
        'it MUST connect as the OWNER role (`commerce_ddl`), which is distinct ' +
        'from the low-privilege app role (`commerce_app`, COMMERCE_APP_DATABASE_URL) ' +
        'the runtime base handle uses. Set the owner URL in Infisical / the deploy ' +
        'environment before running `pnpm db:backfill-demo`.',
    );
  }
  return ownerUrl;
}

/** One copyable column: its name plus the SELECT-side expression to read it. */
interface CopyColumn {
  /** Bare column name (quoted at the SQL site): the INSERT target list. */
  column: string;
  /**
   * The SELECT-side expression. Plain `"col"` for ordinary columns; for a
   * USER-DEFINED (enum) column it is `"col"::text::"<udt_schema>"."<udt_name>"`,
   * the TARGET schema's type. Each `tg_<id>` schema owns its OWN enum types
   * (000_enums runs per schema), and Postgres does not cast between two
   * distinct enum types implicitly, so a bare cross-schema `INSERT ... SELECT`
   * fails with e.g. `column "movement_type" is of type tg_x."StockMovementType"
   * but expression is of type commerce."StockMovementType"`. Round-tripping
   * through text is lossless for enums (same label set).
   */
  select: string;
}

/**
 * Compute the EXPLICIT, writable column list to copy for one table: the target
 * schema's columns that are NOT `GENERATED ALWAYS` and not in {@link NEVER_COPY},
 * in ordinal order, INTERSECTED with the columns that actually exist in the source
 * schema. Driving the list off `information_schema` (rather than a hardcoded list)
 * makes the copy robust to any source/target column drift: a column present in
 * only one schema is simply skipped, and the target's default applies for a column
 * the source lacks. Returns `[]` when the table is absent from either schema.
 */
async function copyableColumns(
  sql: postgres.Sql,
  targetSchema: string,
  table: string,
): Promise<CopyColumn[]> {
  const targetRows = await sql<
    { column_name: string; data_type: string; udt_schema: string; udt_name: string }[]
  >`
    SELECT column_name, data_type, udt_schema, udt_name
    FROM information_schema.columns
    WHERE table_schema = ${targetSchema}
      AND table_name = ${table}
      AND is_generated <> 'ALWAYS'
    ORDER BY ordinal_position
  `;
  const sourceRows = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ${SOURCE_SCHEMA}
      AND table_name = ${table}
  `;
  const sourceSet = new Set(sourceRows.map((row) => row.column_name));
  return targetRows
    .filter((row) => !NEVER_COPY.has(row.column_name) && sourceSet.has(row.column_name))
    .map((row) => ({
      column: row.column_name,
      select:
        row.data_type === 'USER-DEFINED'
          ? `"${row.column_name}"::text::"${row.udt_schema}"."${row.udt_name}"`
          : `"${row.column_name}"`,
    }));
}

/**
 * Rule 6 (completeness): every BASE TABLE present in BOTH the source and target
 * schemas must be named in {@link BACKFILL_TABLES}. A commerce table added after
 * CM-12 that reaches both schemas without being added to the copy list would be
 * a silent data drop; throw instead.
 */
async function assertBackfillCoversAllSharedTables(
  sql: postgres.Sql,
  targetSchema: string,
): Promise<void> {
  const shared = await sql<{ table_name: string }[]>`
    SELECT s.table_name
    FROM information_schema.tables s
    JOIN information_schema.tables t
      ON t.table_name = s.table_name AND t.table_schema = ${targetSchema}
    WHERE s.table_schema = ${SOURCE_SCHEMA}
      AND s.table_type = 'BASE TABLE'
      AND t.table_type = 'BASE TABLE'
  `;
  const covered = new Set<string>(BACKFILL_TABLES);
  const missing = shared.map((row) => row.table_name).filter((name) => !covered.has(name));
  if (missing.length > 0) {
    throw new Error(
      `backfillDemoTenant: table(s) present in both "${SOURCE_SCHEMA}" and ` +
        `"${targetSchema}" but MISSING from BACKFILL_TABLES (their rows would be ` +
        `silently dropped): ${missing.join(', ')}. Add them to BACKFILL_TABLES in ` +
        'FK-safe order.',
    );
  }
}

/**
 * Provision the demo tenant-group's `tg_<demo>` schema (idempotent) and copy the
 * current `commerce.<table>` rows into it, FK-safe, excluding the GENERATED /
 * trigger-maintained columns (they regenerate). Advances the target's
 * `order_number_seq` past the highest copied order number and restamps the
 * legacy 'demo-tenant-group' sentinel on the public sites-family rows.
 * Re-runnable: a second call provisions nothing new and copies nothing already
 * present.
 *
 * @param opts.tenantGroupId The demo tenant-group id (a strict UUID; the
 *   `tg_<hex32>` schema name is DERIVED via the tenant-db chokepoint, never built
 *   by hand). Use {@link DEMO_TENANT_GROUP_ID} from demoTenant.ts.
 * @param opts.slug Registry slug recorded on the `public.tenant_groups` row.
 *   Defaults to `'demo'` (the demo tenant-group's slug). The slug TRAVELS WITH
 *   the tenant-group id: `tenant_groups.slug` is UNIQUE, and the runner's
 *   registry upsert conflicts only on `id`, so provisioning a DIFFERENT
 *   tenant-group under an already-taken slug fails loudly on
 *   `tenant_groups_slug_key` (correctly, a slug names exactly one group).
 *   Re-running with the SAME (id, slug) pair stays a no-op.
 * @param opts.connectionString Optional OWNER url override (tests). Defaults to
 *   `COMMERCE_OWNER_DATABASE_URL`, read at call time.
 *
 * @throws Error if no OWNER connection string is available, or if a table shared
 *   by both schemas is missing from BACKFILL_TABLES.
 */
export async function backfillDemoTenant(opts: {
  tenantGroupId: string;
  slug?: string;
  connectionString?: string;
}): Promise<void> {
  const ownerUrl = requireOwnerUrl(opts.connectionString);
  // DERIVE the schema name through the chokepoint (validates the UUID + strips to
  // `tg_<hex32>`); never hand-build it.
  const tgId = assertTenantGroupId(opts.tenantGroupId);
  const targetSchema = tenantSchema(tgId);

  // (1) Ensure `tg_<demo>` exists with the commerce tables + grants + ext-backstop.
  // Advisory-locked + idempotent: a no-op if it is already provisioned.
  await provisionCommerceTenant({
    tenantGroupId: opts.tenantGroupId,
    // The slug follows the caller's tenant-group, defaulting to the demo's own.
    // Hardcoding 'demo' here regardless of tenantGroupId was a real bug: any
    // SECOND tenant-group backfilled while the demo group exists collided on
    // the UNIQUE tenant_groups.slug (tenant_groups_slug_key).
    slug: opts.slug ?? 'demo',
    connectionString: ownerUrl,
  });

  const sql = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    // (2) Rule 6: refuse to run a copy list that misses a shared table.
    await assertBackfillCoversAllSharedTables(sql, targetSchema);

    // (3) Copy each table commerce.<t> -> tg_<demo>.<t>, FK order, owner role.
    for (const table of BACKFILL_TABLES) {
      const columns = await copyableColumns(sql, targetSchema, table);
      if (columns.length === 0) continue; // table absent in source or target

      const insertList = columns.map((c) => `"${c.column}"`).join(', ');
      const selectList = columns.map((c) => c.select).join(', ');
      // EXPLICIT column list on both sides so the GENERATED / trigger columns are
      // never copied; enum columns cast source-type -> text -> TARGET-schema type
      // (see CopyColumn). ON CONFLICT DO NOTHING makes the whole backfill
      // idempotent: a re-run skips rows that already exist (on any unique / PK
      // conflict).
      const result = await sql.unsafe(
        `INSERT INTO "${targetSchema}"."${table}" (${insertList}) ` +
          `SELECT ${selectList} FROM "${SOURCE_SCHEMA}"."${table}" ` +
          `ON CONFLICT DO NOTHING`,
      );
      console.log(`[backfill-demo] ${targetSchema}.${table}: copied ${result.count} row(s)`);
    }

    // (4) Rule 4: advance the target's fresh order_number_seq past the highest
    // copied ORD-%06d number, so the first sequence-drawn order after the CM-10
    // flip does not collide with a copied order_number (UNIQUE). When the target
    // has no numeric order numbers, is_called stays false and the next nextval
    // is 1. Recomputed from the target's own rows, so a re-run is idempotent and
    // never rewinds past later, sequence-drawn orders.
    await sql.unsafe(
      `SELECT setval(
         '"${targetSchema}"."order_number_seq"',
         GREATEST(mx.n, 1),
         mx.n >= 1
       )
       FROM (
         SELECT COALESCE(
           MAX((substring("order_number" FROM '^ORD-(\\d+)$'))::bigint),
           0
         ) AS n
         FROM "${targetSchema}"."order"
       ) AS mx`,
    );

    // (5) Rule 5: restamp the legacy string sentinel on the public sites-family
    // rows to the real tenant-group UUID, so the CM-10 flip (which derives the
    // schema from site.tenant_group_id through the strict-UUID chokepoint) does
    // not 500 on pre-CM-12 demo rows. Idempotent: a re-run matches zero rows.
    // `tgId` is chokepoint-validated (a strict UUID) and the sentinel is a
    // constant, so interpolating them here is injection-safe.
    for (const table of RESTAMP_TABLES) {
      const restamped = await sql.unsafe(
        `UPDATE "public"."${table}" SET "tenant_group_id" = '${tgId}' ` +
          `WHERE "tenant_group_id" = '${LEGACY_DEMO_TENANT_GROUP_ID}'`,
      );
      if (restamped.count > 0) {
        console.log(
          `[backfill-demo] public.${table}: restamped ${restamped.count} legacy demo row(s)`,
        );
      }
    }
  } finally {
    await sql.end();
  }
}
