import 'server-only';

// src/server/commerce/index.ts
//
// Server-only barrel for the commerce bounded module. This is the single
// import surface the rest of the server (route handlers, the render path)
// pulls from. It re-exports:
//
//   - the three transport-agnostic repository contracts (catalog, pricing,
//     order), each taking the scoped Kysely handle first;
//   - the read-only, RSC-callable commerce read repository.
//
// Tenancy: commerce isolates every company in its own `tg_<hex32>` Postgres
// schema (one per auth-brain tenant group), created and migrated by
// @marlinjai/tenant-db and reached through the immutable scoped Kysely handle
// `commerceTenantDb(tgId)` (./db). There is no Prisma and no search_path seam
// anywhere in commerce: the handle schema-qualifies every structured query, and
// every raw `sql` fragment names its table through `tenantSchemaRef(tgId)`.
// `pnpm lint:guards` (scripts/check-guards.mjs, run in CI) enforces that. The
// storefront entry points resolve the tenant group from the request HOST
// (./storefrontTenant, built on ./tenant's resolveTenantGroupForSite) and fail
// closed when a published site has no valid tenant group.
//
// Auth is NOT re-exported and NOT re-created here. Commerce routes own their own
// boundary: the storefront routes gate on the request HOST resolving to a
// published site (resolvePublishedSite), while the editor commerce routes use
// the real auth-brain session path (./editorTenant). Do not add a guard module
// here.
//
// The READ-ONLY commerce repository (getCommerceServerRepository) is the
// catalog READ surface the publish hydrator consumes. It is display-read only
// (no write / reserve / checkout); the server stays authoritative for money and
// stock.

export type {
  CatalogRepository,
  OrderRepository,
  PricingRepository,
} from './repository/types';
export {
  commerceReadRepository,
  getCommerceServerRepository,
  type CommerceReadRepository,
} from './repository/read';
export type { CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
