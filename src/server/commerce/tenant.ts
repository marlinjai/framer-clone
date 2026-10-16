import 'server-only';

// src/server/commerce/tenant.ts
//
// The ONE place a RESOLVED published site becomes the commerce tenant-group id
// its reads and writes run under (CM-10). Commerce isolates by Postgres SCHEMA:
// one `tg_<hex32>` schema per auth-brain tenant group, reached through the
// immutable scoped Kysely handle `commerceTenantDb(tgId)` (src/server/commerce/
// db.ts). Every storefront entry point (the four /api/commerce routes and the
// SSR render route) derives its handle from the value this function returns, so
// the site -> tenant mapping cannot drift between them.
//
// Where the site comes from: the storefront request HOST, resolved to a
// PUBLISHED site by resolvePublishedSite / getCachedPublishedSite. Never a
// session cookie: the published-site plane derives tenancy from the host and
// ignores the apex editor session for authorization (multi-tenancy phase 2
// plan, decisions D2 and D4).
//
// FAIL CLOSED: a site whose tenant group id is missing, empty, or not a strict
// UUID (for example a legacy string sentinel such as 'demo-tenant-group' that
// was never restamped) throws a TenantSchemaError from assertTenantGroupId. No
// schema name is produced, so no query can run, and there is deliberately NO
// fallback to a shared schema. Callers turn that throw into a clear "commerce is
// not provisioned for this storefront" answer (see storefrontTenant.ts).

import { assertTenantGroupId, TenantSchemaError, type TenantGroupId } from '@marlinjai/tenant-db';

import type { PublishedSite } from '@/server/sites/publicResolver';

/**
 * Resolve the commerce tenant-group id for a resolved published site.
 *
 * Returns the validated, branded TenantGroupId. Throws TenantSchemaError (from
 * `@marlinjai/tenant-db`) when the site carries no usable tenant group id
 * (null, undefined, empty, or not a UUID). There is no shared-schema fallback.
 */
export function resolveTenantGroupForSite(
  site: { tenantGroupId?: PublishedSite['tenantGroupId'] | null },
): TenantGroupId {
  return assertTenantGroupId(site.tenantGroupId);
}

/**
 * True when `err` is the tenant-db chokepoint's "not a valid tenant group id"
 * rejection. Checks the class AND the stable `code`, so a second copy of the
 * package (ESM vs CJS build loaded side by side) is still recognized.
 */
export function isTenantSchemaError(err: unknown): err is TenantSchemaError {
  return (
    err instanceof TenantSchemaError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'TENANT_SCHEMA_INVALID')
  );
}
