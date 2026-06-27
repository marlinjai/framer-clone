// src/server/commerce/provisioning/public.ts
//
// CM-03 — the GLOBAL / public tier of the commerce schema-per-tenant-group
// model. Commerce owns NO public commerce tables (product, order, inventory and
// friends are 100% per-tenant; they land in CM-04 as `tg_<id>`-schema
// migrations). The ONLY global objects are:
//
//   - the shared `ext` schema: pgcrypto, `ext.gen_uuid_v7()` (UUIDv7 DEFAULTs),
//     `ext.touch_updated_at()` (the updatedAt trigger fn) — installed by the
//     package's `001_ext_schema` public migration.
//   - the runner's own registry: `public.tenant_groups` (every `tg_<id>` schema
//     is keyed on a row here) + `public.tenant_migration_progress` — installed
//     by `002_tenant_groups`.
//
// Both bodies are owned by @marlinjai/tenant-db's default PUBLIC_MIGRATIONS set;
// this module does NOT re-author them. It only opens the right connection and
// calls the package's `migratePublic`, which is the single source of truth for
// the public tier.
//
// IMPORTANT — this runs DDL (CREATE SCHEMA / EXTENSION / TABLE), so it MUST use
// a DIRECT OWNER connection (`commerce_ddl`, COMMERCE_OWNER_DATABASE_URL), NOT
// the app base singleton from db.ts. That singleton connects as the
// low-privilege `commerce_app` role (role-default search_path = ext, no DDL
// privilege): the wrong handle for migrations. We open our own `max: 1`
// postgres.js client outside any pool and close it in a `finally`.
//
// This is an OPERATOR / DEPLOY step (run via `pnpm db:public`), not a runtime
// code path. It is idempotent: the runner guards via its
// `public.__public_db_migrations` bookkeeping, so re-running on every deploy is
// safe and applies nothing new once the public tier exists.

import postgres from 'postgres';
import { migratePublic } from '@marlinjai/tenant-db';

/**
 * Run the commerce PUBLIC migration set once against a fresh (or already
 * migrated) database, using a DIRECT OWNER connection. Returns the list of
 * migration ids newly applied — empty `[]` on a re-run where the public tier is
 * already present (idempotent).
 *
 * @param connectionString
 *   Optional owner connection string. Defaults to
 *   `process.env.COMMERCE_OWNER_DATABASE_URL`, read at CALL TIME (not import) so
 *   `next build` and module import never require a live DB. This MUST be the
 *   OWNER role (`commerce_ddl`) — it does DDL — which is distinct from the app
 *   role (`commerce_app`) the runtime base handle uses.
 *
 * @throws Error if no owner connection string is available.
 */
export async function migrateCommercePublic(connectionString?: string): Promise<string[]> {
  const ownerUrl = connectionString ?? process.env.COMMERCE_OWNER_DATABASE_URL;
  if (!ownerUrl) {
    throw new Error(
      'COMMERCE_OWNER_DATABASE_URL is not set. The public migrations run DDL ' +
        '(CREATE SCHEMA/EXTENSION/TABLE) and MUST connect as the OWNER role ' +
        '(`commerce_ddl`), which is distinct from the low-privilege app role ' +
        '(`commerce_app`, COMMERCE_APP_DATABASE_URL) the runtime base handle ' +
        'uses. Set the owner URL in Infisical / the deploy environment before ' +
        'running `pnpm db:public`.',
    );
  }

  // A direct, single-connection owner client OUTSIDE the app pool. `prepare:
  // false` keeps it pooler-safe; `max: 1` because this is a one-shot migration
  // runner, not a serving pool.
  const sql = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    // Pass NOTHING for the second arg: use the package-default PUBLIC_MIGRATIONS
    // (001_ext_schema + 002_tenant_groups). The package owns those bodies.
    return await migratePublic(sql);
  } finally {
    await sql.end();
  }
}
