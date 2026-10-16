import 'server-only';

// src/server/commerce/index.ts
//
// Server-only barrel for the commerce bounded module. This is the single
// import surface the rest of the server (route handlers, realtime consumers,
// later commerce specs) pulls from. It re-exports:
//
//   - the four transport-agnostic repository interfaces.
//   - the read-only, RSC-callable commerce read repositories.
//
// Tenancy (CM-10): there is no search_path seam any more. Commerce isolates by
// a `tg_<hex32>` schema per tenant group, reached through the immutable scoped
// Kysely handle `commerceTenantDb(tgId)` (./db). The storefront entry points
// resolve the tenant group from the request HOST (./storefrontTenant, built on
// ./tenant's resolveTenantGroupForSite) and fail closed when a published site
// has no valid tenant group.
//
// Auth is NOT re-exported and NOT re-created here. Commerce routes own their own
// boundary: the storefront routes gate on the request HOST resolving to a
// published site (resolvePublishedSite), while authenticated commerce mutations
// use the real auth-brain path. Do not add a guard module here.
//
// data-table's adapter-prisma is deliberately NOT imported anywhere in this
// module: its `transaction()` is a verified no-op, so it cannot be the system
// of record for stock or money.
//
// The READ-ONLY, RSC-callable commerce repository (getCommerceServerRepositoryDb)
// is re-exported here: it is the catalog READ surface the publish hydrator
// consumes. It is display-read only (no write / reserve / checkout); the server
// stays authoritative for money and stock.

export type {
  CatalogRepository,
  InventoryRepository,
  OrderRepository,
  PricingRepository,
} from './repository/types';
export {
  // LEGACY tx-first Prisma read repo (no production caller since CM-10; CM-13
  // deletes it).
  commerceReadRepository,
  type CommerceReadRepository,
  // The live Kysely read path (CM-07, wired by CM-10). CM-13 renames these to
  // canonical once the Prisma path is gone.
  commerceReadRepositoryKysely,
  getCommerceServerRepositoryDb,
  type CommerceReadRepositoryKysely,
} from './repository/read';
export type { CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
