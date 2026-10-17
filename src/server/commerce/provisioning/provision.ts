// src/server/commerce/provisioning/provision.ts
//
// CM-11 — the PER-TENANT provisioning + FLEET-migration tier of the commerce
// schema-per-tenant-group model. CM-03's `public.ts` stands up the GLOBAL tier
// (the shared `ext` schema + the runner's `public.tenant_groups` registry).
// THIS module stands up one org's `tg_<id>` commerce schema on top of it, and
// rolls new commerce DDL across the whole fleet of already-provisioned orgs.
//
// Both entrypoints run DDL (CREATE SCHEMA / TABLE / GRANT / ALTER ROLE), so they
// MUST use a DIRECT OWNER connection (`commerce_ddl`, COMMERCE_OWNER_DATABASE_URL),
// NEVER the app base singleton from db.ts. That singleton connects as the
// low-privilege `commerce_app` role (role-default search_path = ext, no DDL
// privilege, ext-backstopped): the wrong handle for provisioning. We open our
// own `max: 1` postgres.js client OUTSIDE any pool and close it in a `finally`,
// exactly as `public.ts` does. This keeps provisioning out-of-band from the
// request's app-role pool.
//
// The runner (@marlinjai/tenant-db) owns ALL the hard parts: it is atomic,
// advisory-locked (per tenant_group, held for the WHOLE provision), and
// idempotent — registry upsert -> CREATE SCHEMA -> inline migrations under the
// lock -> verify -> per-schema grants -> `ext`-locked role default (the backstop)
// -> status='active'. We do NOT add our own locking or a second registry; we
// supply the OWNER connection and the commerce migration set and let the runner
// do the work.
//
// ALWAYS pass `appRole: 'commerce_app'`. The no-appRole path skips the
// per-schema grants AND the `ext` role-default backstop, so it is forbidden in
// prod (it would leave the new schema unreachable by the app role and the app
// role's search_path unlocked).
//
// APPEND-ONLY REVOKES (found and fixed in CM-13). The runner runs the tenant
// migrations, whose bodies REVOKE UPDATE, DELETE on the append-only tables from
// commerce_app, and THEN `grantSchemaToAppRole` issues
// `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`, which silently undoes
// those REVOKEs. Left alone, commerce_app could rewrite or delete a placed order
// (a German invoice), its lines, a credit note or a stock movement. So every
// provision re-applies the REVOKEs through the runner's `seed` hook, which runs
// INSIDE the same owner transaction, after the grants and before the schema is
// marked active: there is no moment in which the app role holds those rights.
// `migrateAllTenants` does not re-grant existing tables, so the REVOKEs survive
// fleet migrations; a future migration that adds an append-only table must
// REVOKE in its own body (the schema's default privileges grant it otherwise)
// and be added to APPEND_ONLY_TABLES.

import postgres from 'postgres';
import {
  provisionTenant,
  migrateAllTenants,
  type MigrateAllResult,
} from '@marlinjai/tenant-db';
import { COMMERCE_TENANT_MIGRATIONS } from '../migrations/tenant';

/**
 * The commerce tables commerce_app may only INSERT into and SELECT from: the
 * stock ledger, the corrective documents, and the placed order (an immutable
 * invoice) with its lines.
 */
export const APPEND_ONLY_TABLES = [
  'stock_movement',
  'credit_note',
  'credit_note_ref',
  'order',
  'order_line_item',
] as const;

/**
 * The low-privilege app role granted per-schema USAGE + table access by the
 * runner, and whose default search_path the runner locks to `ext`. MUST match
 * the role `COMMERCE_APP_DATABASE_URL` connects as (see prisma/sql/commerce-roles.sql
 * + db.ts). Passing it is mandatory: the no-appRole path is forbidden in prod.
 */
export const COMMERCE_APP_ROLE = 'commerce_app';

/**
 * REVOKE UPDATE, DELETE on every append-only table of `schema` from the app
 * role. Idempotent. Pass it as `provisionTenant`'s `seed` (via
 * {@link commerceProvisionOptions}) so it runs inside the provisioning
 * transaction, after the runner's grant-all.
 */
export async function revokeAppendOnlyWrites(
  tx: postgres.TransactionSql,
  schema: string,
  appRole: string = COMMERCE_APP_ROLE,
): Promise<void> {
  for (const table of APPEND_ONLY_TABLES) {
    await tx`REVOKE UPDATE, DELETE ON ${tx(schema)}.${tx(table)} FROM ${tx(appRole)}`;
  }
}

/**
 * The full `provisionTenant` options for one commerce tenant group: the commerce
 * migration set, the app role (grants + `ext` backstop) and the append-only
 * REVOKE seed. Every caller that provisions a commerce schema (this module, the
 * integration harness, the test fixtures) uses it, so none can forget a part.
 */
export function commerceProvisionOptions(tenantGroupId: string, slug: string) {
  return {
    tenantGroupId,
    slug,
    appRole: COMMERCE_APP_ROLE,
    tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
    seed: (tx: postgres.TransactionSql, ctx: { schema: string }) => revokeAppendOnlyWrites(tx, ctx.schema),
  };
}

/**
 * Resolve the OWNER connection string at CALL TIME (not import) so `next build`
 * and module import never require a live DB. Throws a clear, role-naming error
 * if it is unset — the same contract as `migrateCommercePublic`.
 */
function requireOwnerUrl(connectionString?: string): string {
  const ownerUrl = connectionString ?? process.env.COMMERCE_OWNER_DATABASE_URL;
  if (!ownerUrl) {
    throw new Error(
      'COMMERCE_OWNER_DATABASE_URL is not set. Per-tenant provisioning and ' +
        'fleet migration run DDL (CREATE SCHEMA/TABLE/GRANT, ALTER ROLE) and ' +
        'MUST connect as the OWNER role (`commerce_ddl`), which is distinct ' +
        'from the low-privilege app role (`commerce_app`, COMMERCE_APP_DATABASE_URL) ' +
        'the runtime base handle uses. Set the owner URL in Infisical / the ' +
        'deploy environment before provisioning a tenant.',
    );
  }
  return ownerUrl;
}

/**
 * Provision (or re-provision) ONE tenant-group's commerce schema. Atomic,
 * advisory-locked, idempotent — driven entirely by the runner's
 * `provisionTenant`.
 *
 * Opens a DIRECT OWNER postgres.js connection (`max: 1`, `prepare: false`,
 * pooler-safe), provisions `tg_<id>` with the CM-04 commerce migration set and
 * the `commerce_app` grants + `ext`-locked backstop, then closes the connection
 * in a `finally`. Returns the runner's `{ schema, applied }` (schema = the
 * derived `tg_<hex32>` name; applied = migration ids newly applied this call,
 * empty `[]` on a no-op re-provision).
 *
 * Idempotent: a second call for the same tenant-group BLOCKS on the per-org
 * advisory lock if one is in flight, then sees the schema + migrations already
 * present and no-ops. So this is safe to call from a hot path (e.g. project
 * create) without de-duping.
 *
 * @param opts.tenantGroupId The tenant_group id (validated to a strict UUID by
 *   the runner's chokepoint; the schema name is DERIVED, never echoed).
 * @param opts.slug          URL-safe slug recorded on the registry row.
 * @param opts.connectionString Optional OWNER url override (tests). Defaults to
 *   `COMMERCE_OWNER_DATABASE_URL`, read at call time.
 *
 * @throws Error if no OWNER connection string is available.
 */
export async function provisionCommerceTenant(opts: {
  tenantGroupId: string;
  slug: string;
  connectionString?: string;
}): Promise<{ schema: string; applied: string[] }> {
  const ownerUrl = requireOwnerUrl(opts.connectionString);

  const sql = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    // The app role drives the per-schema grants + the `ext`-locked role default
    // (the backstop); the seed re-applies the append-only REVOKEs after them.
    return await provisionTenant(sql, commerceProvisionOptions(opts.tenantGroupId, opts.slug));
  } finally {
    await sql.end();
  }
}

/**
 * Roll new commerce DDL across the WHOLE fleet of provisioned tenant-groups.
 * Wraps the runner's `migrateAllTenants`: iterate `public.tenant_groups`, derive
 * + tamper-check each `tg_*` schema, and apply the CM-04 commerce migration set
 * to each (already-applied migrations skipped per-schema). Batched + resumable:
 * a failure at schema N does not roll back schemas < N, so a re-run resumes.
 *
 * This is an OPERATOR / DEPLOY step (run via `pnpm db:migrate-tenants`) for
 * SHIPPING new commerce migrations after launch. Pre-MVP the fleet is exactly
 * one demo tenant-group, so it is effectively a no-op until new commerce DDL is
 * added; it exists so the fan-out is one command when there are many orgs.
 *
 * Opens its own DIRECT OWNER connection and closes it in a `finally`, same as
 * `provisionCommerceTenant`.
 *
 * @param opts.batchSize     Process at most this many schemas per call.
 * @param opts.onSchemaDone  Per-schema progress callback (for logging / resume).
 * @param opts.connectionString Optional OWNER url override (tests).
 *
 * @throws Error if no OWNER connection string is available.
 */
export async function migrateAllCommerceTenants(opts?: {
  batchSize?: number;
  onSchemaDone?: (info: {
    schema: string;
    applied: string[];
    index: number;
    total: number;
  }) => void;
  connectionString?: string;
}): Promise<MigrateAllResult> {
  const ownerUrl = requireOwnerUrl(opts?.connectionString);

  const sql = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    return await migrateAllTenants(sql, {
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
      batchSize: opts?.batchSize,
      onSchemaDone: opts?.onSchemaDone,
    });
  } finally {
    await sql.end();
  }
}
