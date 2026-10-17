import 'server-only';

// src/server/commerce/db.ts
//
// The commerce data layer's connection foundation (CM-02). This is the
// @marlinjai/tenant-db Node base singleton, the ONLY database entry point of the
// commerce engine (schema per tenant group). Commerce does not use Prisma at
// all; the PrismaClient in src/server/db.ts serves the CMS and sites only.
//
// Two things live here:
//
//   1. getCommerceBase() — a lazily-constructed, process-wide BASE Kysely
//      instance built with createNodeDb({ connectionString }) from the
//      LOW-PRIVILEGE `commerce_app` role (COMMERCE_APP_DATABASE_URL). The base
//      is un-scoped: it carries no tenant schema. Per request you derive an
//      immutable scoped handle with commerceTenantDb(tgId) (or the re-exported
//      tenantDb(base, tgId)) and thread it into every repo. Never the owner
//      role at runtime.
//
//   2. assertCommerceBackstop() — the startup compliance guard. It asserts the
//      connected role's EFFECTIVE search_path is exactly `ext` (no `public`,
//      no `$user`). If a deploy accidentally points Kysely at the OWNER role
//      (whose default path includes `public`), this throws BackstopError and
//      the app refuses to start rather than silently re-opening the bare-name
//      cross-tenant leak the schema wall exists to close.
//
// Lazy-construct-on-first-call mirrors src/server/db.ts exactly, so importing
// this module costs nothing and `next build` needs no live DATABASE_URL. The
// instance is cached on globalThis so Next.js dev HMR reuses one postgres.js
// pool instead of opening a new pool on every edit.

import { createNodeDb } from '@marlinjai/tenant-db/node';
import { assertBackstop, BackstopError, tenantDb, tenantSchema } from '@marlinjai/tenant-db';
import { tenantSchemaExists } from './schemaProbe';

// Re-export the per-request scoping factory so every repo imports the scoping
// primitive from the commerce data-layer entrypoint, not the raw package.
export { tenantDb } from '@marlinjai/tenant-db';

/**
 * The typed commerce Database shape (CM-05). The real generated interface lives
 * in db-types.ts: global tables under a `public.<name>` key, the 19 commerce
 * tables under bare keys, Generated<> on the GENERATED/trigger/defaulted
 * columns. Re-exported here so every repo imports `CommerceDB` from the data-
 * layer entrypoint, and `createNodeDb<CommerceDB>` below is typed against it.
 */
import type { CommerceDB } from './db-types';
export type { CommerceDB } from './db-types';

/**
 * Build the base (un-scoped) commerce Kysely instance from the low-privilege
 * app role. The connection string is read at FIRST CALL (not at import) from
 * COMMERCE_APP_DATABASE_URL — the `commerce_app` role, whose role-default
 * search_path is `ext` (see prisma/sql/commerce-roles.sql). NEVER the owner
 * role: assertCommerceBackstop() enforces that.
 */
function buildCommerceBase() {
  const connectionString = process.env.COMMERCE_APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'COMMERCE_APP_DATABASE_URL is not set. The commerce base handle must ' +
        'connect as the low-privilege `commerce_app` role (role-default ' +
        'search_path = ext), never the owner role. Set it in Infisical / the ' +
        'deploy environment before the commerce engine is used.',
    );
  }
  return createNodeDb<CommerceDB>({ connectionString });
}

/** The inferred base-handle type (`Kysely<CommerceDB>`) without importing kysely. */
export type CommerceBase = ReturnType<typeof buildCommerceBase>;

const globalForCommerceDb = globalThis as unknown as {
  __framerCloneCommerceBase?: CommerceBase;
  __framerCloneCommerceBackstop?: Promise<void>;
  __framerCloneCommerceSchemas?: Map<string, Promise<void>>;
};

/**
 * The process-singleton commerce base handle. Lazily constructed on first call
 * and cached on globalThis (HMR-safe). Derive a per-request scoped handle from
 * it with commerceTenantDb(tgId) — do NOT query the base directly for tenant
 * tables (a bare-name query fails loudly under the ext-locked path).
 */
export function getCommerceBase(): CommerceBase {
  if (!globalForCommerceDb.__framerCloneCommerceBase) {
    globalForCommerceDb.__framerCloneCommerceBase = buildCommerceBase();
  }
  return globalForCommerceDb.__framerCloneCommerceBase;
}

/**
 * Derive the per-request, immutable, schema-qualified handle for one
 * tenant-group. Every bare table identifier on the returned handle resolves to
 * `tg_<id>.<table>`. Pass a validated TenantGroupId (or a raw UUID string,
 * which tenantDb re-validates through the injection chokepoint).
 *
 * Usage (at the request edge):
 *   const db = commerceTenantDb(resolveTenantGroupForSite(site));
 *   await listProducts(db, args);
 * Derive ONCE per request and thread `db` down; never re-derive per query.
 */
export function commerceTenantDb(tgId: string) {
  return tenantDb(getCommerceBase(), tgId);
}

/**
 * Startup compliance backstop. Assert the base handle's connection runs under
 * the ext-locked search_path (exactly `ext`). Throws BackstopError if `public`
 * or `$user` is on the path — i.e. someone pointed the app at the owner role.
 *
 * Call this ONCE at startup (or at first commerce use) so a misconfigured
 * deploy fails fast instead of silently serving cross-tenant decoys. Do NOT
 * call it on the owner/migration client (that role legitimately has `public`
 * on its path for DDL).
 */
export async function assertCommerceBackstop(): Promise<void> {
  await assertBackstop(getCommerceBase());
}

/**
 * Run the startup backstop ONCE per process, before the first commerce query.
 *
 * Every storefront / editor / render entry point derives its handle through
 * {@link commerceTenantDbChecked}, which awaits this. The check runs lazily on
 * first commerce use (not at import and not in `next build`, which has no
 * database URL), and its success is cached on globalThis, so it costs one round
 * trip per process. It turns every misconfiguration into a loud, named error
 * instead of empty shop slots:
 *   - COMMERCE_APP_DATABASE_URL unset         -> the "is not set" error
 *   - unreachable / placeholder connection    -> "could not verify" with the cause
 *   - the OWNER role (public on its path)     -> BackstopError (re-thrown as is)
 * A FAILED check is not cached, so a transient outage does not wedge the
 * process: the next commerce request checks again.
 */
export function ensureCommerceBackstop(): Promise<void> {
  if (!globalForCommerceDb.__framerCloneCommerceBackstop) {
    const check = (async () => {
      const base = getCommerceBase();
      try {
        await assertBackstop(base);
      } catch (err) {
        if (err instanceof BackstopError) throw err;
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
          'Commerce backstop: could not verify the commerce connection ' +
            '(COMMERCE_APP_DATABASE_URL must point at the low-privilege ' +
            `commerce_app role, search_path = ext): ${cause}`,
          { cause: err },
        );
      }
    })();
    globalForCommerceDb.__framerCloneCommerceBackstop = check;
    check.catch(() => {
      if (globalForCommerceDb.__framerCloneCommerceBackstop === check) {
        globalForCommerceDb.__framerCloneCommerceBackstop = undefined;
      }
    });
  }
  return globalForCommerceDb.__framerCloneCommerceBackstop;
}

/**
 * Thrown when a tenant group id is a valid UUID but its `tg_<id>` schema does
 * not exist (the group was never provisioned for commerce). The request edges
 * map it to the SAME not-provisioned answer as an invalid tenant group: 404
 * `commerce_not_provisioned` on the routes, no commerce data on the render.
 */
export class CommerceTenantNotProvisionedError extends Error {
  readonly code = 'COMMERCE_TENANT_NOT_PROVISIONED';
  constructor(schemaName: string) {
    super(`commerce schema ${schemaName} does not exist (tenant group not provisioned)`);
    this.name = 'CommerceTenantNotProvisionedError';
  }
}

/** True for {@link CommerceTenantNotProvisionedError}, also across module copies. */
export function isCommerceTenantNotProvisioned(err: unknown): boolean {
  return (
    err instanceof CommerceTenantNotProvisionedError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'COMMERCE_TENANT_NOT_PROVISIONED')
  );
}

/**
 * Check ONCE per process and tenant group that its `tg_<id>` schema exists.
 * Success is cached next to the backstop; a failure (missing schema or a probe
 * error) is NOT cached, so provisioning the group later, or a transient outage,
 * heals on the next request without a restart.
 */
function ensureTenantSchema(tgId: string): Promise<void> {
  const schemaName = tenantSchema(tgId);
  const cache = (globalForCommerceDb.__framerCloneCommerceSchemas ??= new Map());
  let check = cache.get(schemaName);
  if (!check) {
    const pending = (async () => {
      if (!(await tenantSchemaExists(getCommerceBase(), schemaName))) {
        throw new CommerceTenantNotProvisionedError(schemaName);
      }
    })();
    cache.set(schemaName, pending);
    pending.catch(() => {
      if (cache.get(schemaName) === pending) cache.delete(schemaName);
    });
    check = pending;
  }
  return check;
}

/**
 * {@link commerceTenantDb}, but only after {@link ensureCommerceBackstop} has
 * passed and the tenant group's schema is known to exist. This is the entry
 * point the request edges use. Throws CommerceTenantNotProvisionedError for an
 * unprovisioned group.
 */
export async function commerceTenantDbChecked(tgId: string) {
  await ensureCommerceBackstop();
  await ensureTenantSchema(tgId);
  return commerceTenantDb(tgId);
}
