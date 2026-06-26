import 'server-only';

// src/server/commerce/tenant.ts
//
// The render-path SEAM that maps a RESOLVED published site to the Postgres
// schema its commerce reads run under (`SET LOCAL search_path`, via
// `withTenant`). The render route (src/app/(site)/[...slug]/page.tsx) calls this
// with the site resolved from the request Host and threads the result into
// `getCommerceServerRepository`, so the commerce catalog is read under the
// schema mapped to that site's tenant rather than a module constant.
//
// LIMITATION (UNTIL MT-18): multi-tenant commerce is BLOCKED to one tenant.
// Commerce isolates by Postgres SCHEMA (one shared `commerce` schema today),
// and the per-tenant schema registry + provisioning + N-schema migration runner
// are NOT built yet — that is MT-18 (Wave 4). So this resolver maps EVERY site
// to the single shared `COMMERCE_SCHEMA`. CMS-only multi-tenant sites are FULLY
// isolated (CMS isolates by a `workspace_id` COLUMN threaded as
// `getCmsRepository(site.workspaceId)`) and MAY ship now; only sites that ENABLE
// commerce share one global catalog/order ledger until MT-18 lands.
//
// This file is deliberately the ONE place that decision lives, so MT-18 swaps a
// constant return for a tenant-registry lookup WITHOUT touching the render route
// or the repository factory: the signature already takes the resolved site and
// returns a schema string.

import type { PublishedSite } from '@/server/sites/publicResolver';
import { COMMERCE_SCHEMA } from './withTenant';

/**
 * Resolve the commerce Postgres schema for a resolved published site.
 *
 * UNTIL MT-18: every site maps to the single shared `COMMERCE_SCHEMA`
 * ('commerce'). The `site` is taken (and named) now so MT-18 can replace the
 * body with a per-tenant registry lookup keyed on `site.tenantGroupId` /
 * `site.workspaceId` with no caller change.
 */
export function resolveCommerceSchemaForSite(
  site: Pick<PublishedSite, 'workspaceId' | 'tenantGroupId'>,
): string {
  // MT-18 keys the per-tenant schema registry on the resolved site's tenant;
  // reference `site` now so the seam's input is real and cannot silently drift
  // before that lookup replaces this constant return.
  void site;
  // Single shared commerce schema for all tenants until the MT-18 registry
  // exists. See the file-header LIMITATION note.
  return COMMERCE_SCHEMA;
}
