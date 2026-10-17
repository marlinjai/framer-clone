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
// The fleet runner re-applies them too: `migrateAllCommerceTenants` runs
// `revokeAppendOnlyWrites` for every schema it processed, so the guarantee does
// not rest on what `migrateAllTenants` happens to grant or not grant today. A
// future migration that adds an append-only table must REVOKE in its own body
// AND be added to APPEND_ONLY_TABLES (a unit test fails if the two disagree).

import postgres from 'postgres';
import {
  assertTenantGroupId,
  provisionTenant,
  migrateAllTenants,
  tenantSchema,
  type MigrateAllResult,
} from '@marlinjai/tenant-db';
import { COMMERCE_TENANT_MIGRATIONS } from '../migrations/tenant';
import {
  acquireAdvisoryLock,
  migrationTimeouts,
  openOwnerSql,
  PROVISION_TIMEOUTS,
  releaseAdvisoryLock,
  type OwnerTimeouts,
} from './ownerSql';

/**
 * The commerce tables commerce_app may only INSERT into and SELECT from: the
 * stock ledger, the corrective documents, the placed order (an immutable
 * invoice) with its lines, and the Books audit trail (sales_document_event, 007).
 */
export const APPEND_ONLY_TABLES = [
  'stock_movement',
  'credit_note',
  'credit_note_ref',
  'order',
  'order_line_item',
  'sales_document_event',
] as const;

/**
 * Session advisory lock key that serializes every commerce provision in the
 * database. Each provision ends with tenant-db's bootstrapAppRole, an
 * `ALTER ROLE commerce_app SET search_path = ext`; two provisions of DIFFERENT
 * tenant groups (two companies creating their first project at the same moment)
 * would both update the same pg_authid row and one fails with "tuple
 * concurrently updated". The runner's own lock is per tenant group, so it does
 * not prevent that. Provisioning is rare and short, so one global lock costs
 * nothing. The integration fixtures take the same key around their direct
 * provisionTenant calls.
 */
export const COMMERCE_PROVISION_LOCK_KEY = 74_610_010;

/**
 * The low-privilege app role granted per-schema USAGE + table access by the
 * runner, and whose default search_path the runner locks to `ext`. MUST match
 * the role `COMMERCE_APP_DATABASE_URL` connects as (see prisma/sql/commerce-roles.sql
 * + db.ts). Passing it is mandatory: the no-appRole path is forbidden in prod.
 */
export const COMMERCE_APP_ROLE = 'commerce_app';

/**
 * REVOKE UPDATE, DELETE, TRUNCATE on every append-only table of `schema` from
 * the app role. Idempotent. (The runner never grants TRUNCATE, so revoking it is
 * belt and braces; it keeps the REVOKE identical to what 007 writes.) Pass it as `provisionTenant`'s `seed` (via
 * {@link commerceProvisionOptions}) so it runs inside the provisioning
 * transaction, after the runner's grant-all.
 */
export async function revokeAppendOnlyWrites(
  tx: postgres.TransactionSql,
  schema: string,
  appRole: string = COMMERCE_APP_ROLE,
): Promise<void> {
  for (const table of APPEND_ONLY_TABLES) {
    await tx`REVOKE UPDATE, DELETE, TRUNCATE ON ${tx(schema)}.${tx(table)} FROM ${tx(appRole)}`;
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
 * The registry slug for a tenant group's commerce schema: the company's display
 * slug plus its full tenant-group id (hyphens removed).
 *
 * `public.tenant_groups.slug` is UNIQUE and the runner's registry upsert
 * conflicts only on `id`, so two companies whose auth-brain display slugs
 * collide (two "acme"s, or a slug reused after a rename) would make the second
 * company's provision fail on `tenant_groups_slug_key` on EVERY project create,
 * forever. Appending the id makes the slug as unique as the id itself, without
 * ever touching another group's row. The display part stays for humans reading
 * the registry; nothing looks a company up by slug.
 */
export function commerceSlugFor(tenantGroupId: string, displaySlug?: string | null): string {
  const id = assertTenantGroupId(tenantGroupId);
  const hex = id.replace(/-/g, '');
  const base = (displaySlug ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  // No display slug, or one that is just the id again: the id alone.
  return base && base !== hex && base !== id.toLowerCase() ? `${base}-${hex}` : hex;
}

/**
 * Run the full provision on an already open OWNER session, under the global
 * provisioning lock (bounded by the session's lock_timeout).
 */
async function provisionUnderLock(
  sql: postgres.Sql,
  tenantGroupId: string,
  slug: string,
  timeouts: OwnerTimeouts,
): Promise<{ schema: string; applied: string[] }> {
  await acquireAdvisoryLock(sql, COMMERCE_PROVISION_LOCK_KEY, 'commerce provisioning lock', timeouts);
  try {
    // The app role drives the per-schema grants + the `ext`-locked role default
    // (the backstop); the seed re-applies the append-only REVOKEs after them.
    return await provisionTenant(sql, commerceProvisionOptions(tenantGroupId, slug));
  } finally {
    await releaseAdvisoryLock(sql, COMMERCE_PROVISION_LOCK_KEY);
  }
}

/**
 * Provision (or re-provision) ONE tenant-group's commerce schema, always running
 * the runner's full `provisionTenant` (registry upsert, migrations, grants, the
 * `ext` backstop, the append-only REVOKEs). Operator and seed paths use it; the
 * project-create request uses {@link ensureCommerceTenant}, which skips all of
 * this for a company that is already provisioned.
 *
 * Opens a DIRECT OWNER session with bounded waits ({@link PROVISION_TIMEOUTS}
 * by default) and closes it in a `finally`. Returns the runner's
 * `{ schema, applied }` (applied is `[]` on a no-op re-provision).
 *
 * Serialized: every provision takes {@link COMMERCE_PROVISION_LOCK_KEY} first,
 * so concurrent provisions of different tenant groups queue instead of
 * colliding on `ALTER ROLE commerce_app`. A wait longer than the lock timeout
 * fails with CommerceLockTimeoutError.
 *
 * @param opts.tenantGroupId The tenant_group id (validated to a strict UUID by
 *   the runner's chokepoint; the schema name is DERIVED, never echoed).
 * @param opts.slug          Slug recorded on the registry row (UNIQUE; see
 *   {@link commerceSlugFor} for a collision-free one).
 * @param opts.connectionString Optional OWNER url override (tests). Defaults to
 *   `COMMERCE_OWNER_DATABASE_URL`, read at call time.
 * @param opts.timeouts      Optional bounded waits (tests).
 *
 * @throws Error if no OWNER connection string is available.
 */
export async function provisionCommerceTenant(opts: {
  tenantGroupId: string;
  slug: string;
  connectionString?: string;
  timeouts?: OwnerTimeouts;
}): Promise<{ schema: string; applied: string[] }> {
  const ownerUrl = requireOwnerUrl(opts.connectionString);
  const timeouts = opts.timeouts ?? PROVISION_TIMEOUTS;
  // max: 1 keeps the advisory lock and the provision on ONE session.
  const sql = await openOwnerSql(ownerUrl, timeouts);
  try {
    return await provisionUnderLock(sql, opts.tenantGroupId, opts.slug, timeouts);
  } finally {
    await sql.end();
  }
}

/** What the registry says about one tenant group's commerce schema. */
export type CommerceTenantState =
  /** Active, schema present, every commerce tenant migration recorded. */
  | 'ready'
  /** Suspended by an operator: never provisioned (that would reactivate it). */
  | 'suspended'
  /** No row, still provisioning, schema gone, or a migration not recorded. */
  | 'missing';

/** A suspended tenant group's commerce schema must not be touched. */
export class CommerceTenantSuspendedError extends Error {
  constructor(tenantGroupId: string) {
    super(
      `Commerce for tenant group ${tenantGroupId} is suspended. Provisioning would ` +
        'reactivate it, so nothing was provisioned; an operator must lift the suspension.',
    );
    this.name = 'CommerceTenantSuspendedError';
  }
}

/**
 * Read the registry for one tenant group. `ready` needs all of: the row is
 * `active`, its schema exists (`to_regnamespace`), and every commerce tenant
 * migration is recorded for that schema. `suspended` wins over everything else.
 */
export async function readCommerceTenantState(
  sql: postgres.Sql,
  tenantGroupId: string,
  schema: string,
): Promise<CommerceTenantState> {
  const rows = await sql<{ status: string; schema_present: boolean; done: string[] }[]>`
    SELECT tg.status,
           to_regnamespace(tg.schema_name) IS NOT NULL AS schema_present,
           COALESCE(array_agg(p.migration_id) FILTER (WHERE p.migration_id IS NOT NULL), '{}') AS done
    FROM public.tenant_groups tg
    LEFT JOIN public.tenant_migration_progress p ON p.schema_name = tg.schema_name
    WHERE tg.id = ${tenantGroupId}::uuid AND tg.schema_name = ${schema}
    GROUP BY tg.status, tg.schema_name
  `;
  if (rows.length === 0) return 'missing';
  const [row] = rows;
  if (row.status === 'suspended') return 'suspended';
  if (row.status !== 'active' || !row.schema_present) return 'missing';
  const done = new Set(row.done);
  return COMMERCE_TENANT_MIGRATIONS.every((m) => done.has(m.id)) ? 'ready' : 'missing';
}

/**
 * Make sure a tenant group's commerce schema exists, cheaply when it already
 * does. The project-create request calls this on every create.
 *
 * Hit: one read of `public.tenant_groups` and `public.tenant_migration_progress`
 * finds the group `active`, its schema present and every commerce tenant
 * migration recorded, and nothing else happens: no lock, no DDL, no
 * `ALTER ROLE`. Miss (first project, a row still `provisioning`, a dropped
 * schema, a migration not recorded): the full provision under the global
 * provisioning lock, exactly as {@link provisionCommerceTenant}. A SUSPENDED
 * group is neither: the runner would set it `active` again, so this throws
 * {@link CommerceTenantSuspendedError} and touches nothing.
 *
 * @returns `provisioned: true` when the full provision ran.
 * @throws CommerceTenantSuspendedError for a suspended tenant group.
 */
export async function ensureCommerceTenant(opts: {
  tenantGroupId: string;
  slug: string;
  connectionString?: string;
  timeouts?: OwnerTimeouts;
}): Promise<{ schema: string; applied: string[]; provisioned: boolean }> {
  const ownerUrl = requireOwnerUrl(opts.connectionString);
  const timeouts = opts.timeouts ?? PROVISION_TIMEOUTS;
  const tgId = assertTenantGroupId(opts.tenantGroupId);
  const schema = tenantSchema(tgId);

  const sql = await openOwnerSql(ownerUrl, timeouts);
  try {
    const state = await readCommerceTenantState(sql, tgId, schema);
    if (state === 'ready') return { schema, applied: [], provisioned: false };
    if (state === 'suspended') throw new CommerceTenantSuspendedError(tgId);
    const result = await provisionUnderLock(sql, tgId, opts.slug, timeouts);
    return { ...result, provisioned: true };
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
 * @param opts.timeouts      Bounded waits; defaults to migrationTimeouts().
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
  timeouts?: OwnerTimeouts;
}): Promise<MigrateAllResult> {
  const ownerUrl = requireOwnerUrl(opts?.connectionString);

  const sql = await openOwnerSql(ownerUrl, opts?.timeouts ?? migrationTimeouts());
  try {
    const result = await migrateAllTenants(sql, {
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
      batchSize: opts?.batchSize,
      onSchemaDone: opts?.onSchemaDone,
    });
    // Re-assert the append-only REVOKEs on every processed schema (idempotent),
    // independent of the runner's grant behaviour.
    for (const { schema } of result.schemas) {
      await sql.begin((tx) => revokeAppendOnlyWrites(tx, schema));
    }
    return result;
  } finally {
    await sql.end();
  }
}
