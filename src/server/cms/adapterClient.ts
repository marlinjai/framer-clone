import 'server-only';

// src/server/cms/adapterClient.ts
//
// Builds the single CMS `PrismaAdapter` over the Track-0 PrismaClient singleton.
//
// One PrismaClient, one @prisma/client (the Track-0 6.x instance from
// src/server/db.ts): `pnpm why @prisma/client` resolves to exactly one. The
// adapter is a thin wrapper around that client, so it is cached at module scope
// to reuse its formula/rollup engines across calls (the underlying client is
// already cached on globalThis for HMR safety).
//
// Transaction semantics note (verified against
// data-table/packages/adapter-prisma/src/adapter.ts:894): `adapter.transaction`
// is a NO-OP that simply invokes `fn(this)` with no surrounding DB transaction.
// Multi-row atomicity is therefore the CONSUMER's concern via the underlying
// `prisma.$transaction`; single-entity DDL is atomic on its own per the
// adapter's atomicDDL (data-table/packages/adapter-prisma/src/ddl.ts). The read
// repository in this slice performs only single statements, so this is a
// non-issue here, but write slices must wrap multi-step work in
// `getPrismaClient().$transaction(...)` (or `withTenant`) themselves.

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { getPrismaClient } from '@/server/db';

/**
 * The single-tenant Postgres schema the CMS engine is pinned to in Phase 1.
 * Every CMS query runs against the default `public` schema. The E7
 * multi-tenant seam (see withTenant.ts) will later swap this for a per-tenant
 * schema via `SET LOCAL search_path`.
 */
export const CMS_SCHEMA = 'public';

/**
 * The single-tenant workspace id. adapter-prisma scopes tables by workspace;
 * Phase 1 has exactly one workspace, so `listCollections()` lists the tables
 * under this constant.
 */
export const CMS_WORKSPACE_ID = 'framer-clone';

let cachedAdapter: PrismaAdapter | null = null;

/**
 * Return the process-wide CMS adapter, bound to the constant single-tenant
 * schema (CMS_SCHEMA) via the shared PrismaClient. Constructed lazily so
 * importing this module costs nothing and `next build` needs no live database.
 */
export function getCmsAdapter(): PrismaAdapter {
  if (!cachedAdapter) {
    cachedAdapter = new PrismaAdapter({ prisma: getPrismaClient() });
  }
  return cachedAdapter;
}
