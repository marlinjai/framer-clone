import 'server-only';

// src/server/commerce/index.ts
//
// Server-only barrel for the commerce bounded module. This is the single
// import surface the rest of the server (route handlers, realtime consumers,
// later commerce specs) pulls from. It re-exports:
//
//   - withTenant + COMMERCE_SCHEMA: the constant-schema SET LOCAL seam.
//   - the four transport-agnostic repository interfaces.
//
// Auth is NOT re-exported and NOT re-created here. Commerce routes own their own
// boundary: the storefront order-create route gates on the request HOST
// resolving to a published site (resolvePublishedSite), while authenticated
// commerce mutations use the real auth-brain path. A route authorizes, then opens
// `withTenant`, then drives a repository with the tx. Do not add a guard module
// here.
//
// data-table's adapter-prisma is deliberately NOT imported anywhere in this
// module: its `transaction()` is a verified no-op, so it cannot be the system
// of record for stock or money. Commerce uses the purpose-built PrismaClient
// singleton (src/server/db.ts) exclusively.
//
// The READ-ONLY, RSC-callable commerce repository (getCommerceServerRepository)
// is also re-exported here: it is the build-time catalog READ surface the
// publish hydrator consumes. It is display-read only (no write / reserve /
// checkout); the server stays authoritative for money and stock.

export { COMMERCE_SCHEMA, withTenant } from './withTenant';
export type {
  CatalogRepository,
  InventoryRepository,
  OrderRepository,
  PricingRepository,
} from './repository/types';
export {
  commerceReadRepository,
  getCommerceServerRepository,
  type CommerceReadRepository,
  // CM-07 EXPAND — the NEW Kysely read path, re-exported ALONGSIDE the Prisma
  // path above. CM-10 wires the render path/routes to getCommerceServerRepositoryDb;
  // CM-13 deletes the Prisma path and renames these to canonical.
  commerceReadRepositoryKysely,
  getCommerceServerRepositoryDb,
  type CommerceReadRepositoryKysely,
} from './repository/read';
export type { CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
