import 'server-only';

// src/server/commerce/storefrontTenant.ts
//
// The storefront EDGE of commerce tenancy (CM-10): turns a request HOST (the
// four /api/commerce routes) or an already-resolved published site (the SSR
// render route) into the per-request scoped Kysely handle, and fails CLOSED
// when the site has no valid tenant group.
//
//   host -> resolvePublishedSite(host) -> resolveTenantGroupForSite(site)
//        -> commerceTenantDb(tgId)  (every bare table resolves to tg_<id>.<table>)
//
// The tenant comes from the storefront HOST only, never a session cookie
// (multi-tenancy phase 2 plan, D2 + D4): the published-site plane ignores the
// apex editor session for authorization, and an anonymous buyer has no session.
//
// Fail-closed answers, deliberately distinct:
//   - 403 `forbidden`: the host does not resolve to a PUBLISHED site. Not a
//     storefront at all (unchanged from the pre-CM-10 orders gate).
//   - 404 `commerce_not_provisioned`: the host IS a published site, but the
//     site carries no valid tenant group id (null, empty, or a legacy non-UUID
//     sentinel), or a valid one whose tg_<id> schema was never created, so
//     there is no commerce schema to read or write. 404 because,
//     from the buyer's side, this storefront's catalog/cart simply does not
//     exist. NOT 409: the storefront checkout client treats every 409 from
//     POST /api/commerce/orders as a stock shortage (CheckoutButton.tsx) and
//     would show an empty "some items are short" state instead of an error.
//     NOT the plain `not_found` code either, which the detail route already
//     uses for "no product with this handle".
// No path falls back to a shared schema.

import type { TenantGroupId } from '@marlinjai/tenant-db';
import type { Kysely } from 'kysely';

import { jsonError } from '@/lib/api/respond';
import {
  treeNeedsCommerceRepo,
  type CommerceServerRepository,
  type ComponentNode,
} from '@/lib/renderer/publish/hydrateBindings';
import { resolvePublishedSite, type PublishedSite } from '@/server/sites/publicResolver';
import {
  commerceTenantDbChecked,
  isCommerceTenantNotProvisioned,
  type CommerceDB,
} from './db';
import { getCommerceServerRepositoryDb } from './repository/read';
import { isTenantSchemaError, resolveTenantGroupForSite } from './tenant';

/** The error code every storefront route answers with when commerce is not provisioned. */
export const COMMERCE_NOT_PROVISIONED = 'commerce_not_provisioned';

export type StorefrontCommerce =
  | {
      ok: true;
      site: PublishedSite;
      tenantGroupId: TenantGroupId;
      /** The scoped handle for THIS request; derive once, thread everywhere. */
      db: Kysely<CommerceDB>;
    }
  | { ok: false; response: Response };

/**
 * Resolve the storefront commerce context for a request host. Returns the
 * scoped handle on success, or the ready-to-return 403 / 404 response. Any
 * other failure (database down, COMMERCE_APP_DATABASE_URL missing) THROWS so the
 * route surfaces it as its own 500 envelope.
 */
export async function resolveStorefrontCommerce(
  host: string | null | undefined,
): Promise<StorefrontCommerce> {
  const site = await resolvePublishedSite(host);
  if (!site) {
    return { ok: false, response: jsonError('forbidden', 'not a published storefront', 403) };
  }

  const notProvisioned: StorefrontCommerce = {
    ok: false,
    response: jsonError(
      COMMERCE_NOT_PROVISIONED,
      'commerce is not provisioned for this storefront',
      404,
    ),
  };

  let tenantGroupId: TenantGroupId;
  try {
    tenantGroupId = resolveTenantGroupForSite(site);
  } catch (err) {
    if (isTenantSchemaError(err)) return notProvisioned;
    throw err;
  }

  try {
    return { ok: true, site, tenantGroupId, db: await commerceTenantDbChecked(tenantGroupId) };
  } catch (err) {
    // A valid tenant group UUID whose tg_<id> schema does not exist: the SAME
    // not-provisioned answer as an invalid id (never a 500 with internals).
    if (isCommerceTenantNotProvisioned(err)) {
      console.error(`[commerce] site ${site.siteId}: ${(err as Error).message}`);
      return notProvisioned;
    }
    throw err;
  }
}

/**
 * The commerce read repository for the SSR render of a resolved published page.
 *
 *   - The page has NO bound commerce source (treeNeedsCommerceRepo is false):
 *     returns undefined WITHOUT touching the commerce connection, so a CMS-only
 *     page renders even when COMMERCE_APP_DATABASE_URL is unset.
 *   - The site has no valid tenant group: returns undefined (fail closed: the
 *     page still renders its CMS content and every commerce binding resolves to
 *     the hydrator's unbound placeholder, so no commerce data from any schema is
 *     shown).
 *   - Otherwise: the scoped repository, built only after the startup backstop
 *     passed. A misconfigured connection (unset, unreachable, placeholder, or
 *     the owner role) REJECTS here, so the render fails loudly instead of the
 *     hydrator's per-slot swallow turning it into silently empty shop slots.
 *
 * `build` is injectable for tests.
 */
export async function commerceRepoForSite(
  site: Pick<PublishedSite, 'siteId' | 'tenantGroupId'>,
  root: ComponentNode,
  build: (tenantGroupId: TenantGroupId) => Promise<CommerceServerRepository> = async (
    tenantGroupId,
  ) => getCommerceServerRepositoryDb(await commerceTenantDbChecked(tenantGroupId)),
): Promise<CommerceServerRepository | undefined> {
  if (!treeNeedsCommerceRepo(root)) return undefined;

  let tenantGroupId: TenantGroupId;
  try {
    tenantGroupId = resolveTenantGroupForSite(site);
  } catch (err) {
    if (isTenantSchemaError(err)) {
      console.error(
        `[commerce] site ${site.siteId} has no valid tenant group; rendering without commerce data`,
      );
      return undefined;
    }
    throw err;
  }
  try {
    return await build(tenantGroupId);
  } catch (err) {
    // A valid tenant group UUID whose tg_<id> schema does not exist: render
    // WITHOUT commerce data (logged), exactly like an invalid tenant group,
    // instead of silently empty shop slots.
    if (isCommerceTenantNotProvisioned(err)) {
      console.error(
        `[commerce] site ${site.siteId}: ${(err as Error).message}; rendering without commerce data`,
      );
      return undefined;
    }
    throw err;
  }
}
