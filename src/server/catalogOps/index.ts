import 'server-only';

// src/server/catalogOps/index.ts
//
// The catalogue operations for agents (plan docs/plans/2026-11-27-agent-catalogue-tools.md, slice 1): what
// the MCP catalogue tools (src/server/mcp/catalogTools.ts) run. No query of its own: every read goes through
// the repository functions the editor's catalogue routes call (src/server/catalog/repository).
//
// A catalogue is named by its SITE, under both models the plan leaves open to Marlin (the catalogue per
// company, or per project): "the catalogue of this site" is today the company's products not switched off for
// the site, and after a per-project migration the site's own products. Collections are left out until that
// answer, so nothing read now changes meaning later.
//
// Who may read what, checked on every call, first failure wins (the plan's "How the company and the site are
// verified"):
//
//   1. The caller arrives verified (keyCaller, src/server/mcp/handler.ts): its company, workspace and tenant
//      group come from the key's verification, never from the request. That verification also refused a key
//      whose workspace holds a site stamped with another company (verifyCompanyKey's site-row check), so a
//      site found in the caller's workspace belongs to the caller's company.
//   2. The action: viewSite for reads (the editor's catalogue rule); a permission service that cannot answer is
//      `unavailable`, never a yes or a no.
//   3. The site: looked up in the caller's workspace and tenant group (branchOfSite). Another company's site is
//      `site_not_found`; a branch id resolves to its main site, which owns the catalogue.
//   4. The shop schema of the caller's tenant group; not provisioned is `catalog_not_provisioned`.
//   5. The rows: the catalogue scope filters every query on the caller's company, and on the site. Another
//      company's product, or one switched off for the site, is `not_found`, never `forbidden`.
//
// Nothing here throws for an expected failure; every way out is a result.

import type { Kysely } from 'kysely';
import { assertTenantGroupId } from '@marlinjai/tenant-db';

import type { ProductDetail, ProductListItem } from '@/lib/catalog/types';
import type { SiteOpsAction, SiteOpsCaller } from '@/lib/siteOps/types';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import type { CommerceDB } from '@/server/commerce/db-types';
import { catalogErrorBody } from '@/server/catalog/http/errorResponse';
import { notFound } from '@/server/catalog/errors';
import { getProduct, listProducts } from '@/server/catalog/repository/products';
import { catalogScope, type CatalogScope } from '@/server/catalog/scope';
import { branchOfSite, type BranchOpsDeps } from '@/server/siteOps/branches';

export interface CatalogOpsError {
  code: string;
  message: string;
  [detail: string]: unknown;
}

export type CatalogOpsResult<T> = { ok: true; value: T } | { ok: false; error: CatalogOpsError };

const ok = <T>(value: T): CatalogOpsResult<T> => ({ ok: true, value });
const fail = (error: CatalogOpsError): CatalogOpsResult<never> => ({ ok: false, error });

/** What the operations need from the outside, injectable for tests. */
export interface CatalogOpsDeps {
  /** The site lookup (the branch repository, scoped to the caller). */
  branches?: BranchOpsDeps;
  /** Opens the shop schema of a tenant group (defaults to the checked tenant handle). */
  tenantDb?: (tgId: string) => Promise<Kysely<CommerceDB>>;
}

/** What an unexpected failure answers; its cause is in the server log. */
export const CATALOG_OPS_FAILURE = 'the catalogue operation failed unexpectedly; read the product again before retrying';

/** A site's catalogue, resolved and checked: the company's scope in its shop schema and the main site's id. */
export interface SiteCatalog {
  scope: CatalogScope;
  siteId: string;
}

async function permitted(caller: SiteOpsCaller, action: SiteOpsAction): Promise<CatalogOpsResult<true>> {
  let allowed = false;
  try {
    allowed = await caller.can(action);
  } catch (err) {
    console.error(`[catalog-ops] permission check for ${action} failed`, err instanceof Error ? err.name : typeof err);
    return fail({ code: 'unavailable', message: 'the permission check could not be made; try again', retryAfterSec: 5 });
  }
  return allowed ? ok(true) : fail({ code: 'forbidden', message: `this caller may not ${action}` });
}

const NOT_PROVISIONED: CatalogOpsError = {
  code: 'catalog_not_provisioned',
  message: "this company's shop is not set up yet: a person opens the site's shop or the Catalog in the editor once, then retry",
};

/** Steps 2 to 4 of the file header for one site. */
export async function resolveSiteCatalog(
  caller: SiteOpsCaller,
  siteId: string,
  action: SiteOpsAction,
  deps: CatalogOpsDeps = {},
): Promise<CatalogOpsResult<SiteCatalog>> {
  const allowed = await permitted(caller, action);
  if (!allowed.ok) return allowed;

  const site = await branchOfSite(caller, { siteId }, deps.branches ?? {});
  if (!site.ok) return fail(site.error);
  const mainSiteId = site.value?.mainSiteId ?? siteId;

  let tgId: string;
  try {
    tgId = assertTenantGroupId(caller.scope.tenantGroupId);
  } catch {
    return fail(NOT_PROVISIONED);
  }
  let db: Kysely<CommerceDB>;
  try {
    db = await (deps.tenantDb ?? commerceTenantDbChecked)(tgId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) return fail(NOT_PROVISIONED);
    throw err;
  }
  try {
    return ok({ scope: catalogScope(db, tgId, caller.companyId), siteId: mainSiteId });
  } catch {
    // A company id that is not a lowercase uuid owns no catalogue rows.
    return fail({ code: 'forbidden', message: 'this company has no catalogue' });
  }
}

/** A thrown error as a result: the catalogue's own refusals with their codes, anything else logged and generic. */
function fromError(err: unknown): CatalogOpsResult<never> {
  const body = catalogErrorBody(err);
  if (body) return fail({ ...body.details, code: body.code, message: body.message });
  console.error('[catalog-ops] a catalogue operation failed', err instanceof Error ? err.message : typeof err);
  return fail({ code: 'failed', message: CATALOG_OPS_FAILURE });
}

async function run<T>(
  caller: SiteOpsCaller,
  siteId: string,
  action: SiteOpsAction,
  deps: CatalogOpsDeps,
  body: (catalog: SiteCatalog) => Promise<T>,
): Promise<CatalogOpsResult<T>> {
  try {
    const catalog = await resolveSiteCatalog(caller, siteId, action, deps);
    if (!catalog.ok) return catalog;
    return ok(await body(catalog.value));
  } catch (err) {
    return fromError(err);
  }
}

// ---------- what an agent sees ----------

/** A product of the list as an agent reads it: the table's row without collections (see the file header). */
export type AgentProductListItem = Omit<ProductListItem, 'collections'>;

/** One product as an agent reads it: without collections and without the company's per-site switches. */
export type AgentProduct = Omit<ProductDetail, 'collections' | 'hiddenSiteIds'>;

function listItemView(item: ProductListItem): AgentProductListItem {
  const view: Partial<ProductListItem> = { ...item };
  delete view.collections;
  return view as AgentProductListItem;
}

function productView(product: ProductDetail): AgentProduct {
  const view: Partial<ProductDetail> = { ...product };
  delete view.collections;
  delete view.hiddenSiteIds;
  return view as AgentProduct;
}

// ---------- reads ----------

export interface ListSiteProductsInput {
  siteId: string;
  q?: string;
  status?: 'draft' | 'published' | 'archived' | 'all';
  type?: string;
  stock?: 'in_stock' | 'out_of_stock' | 'untracked';
  sort?: 'updated' | 'title' | 'created' | 'price' | 'stock';
  dir?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

/** One page of the site's products (the editor table's list and paging). */
export async function listSiteProducts(
  caller: SiteOpsCaller,
  input: ListSiteProductsInput,
  deps: CatalogOpsDeps = {},
): Promise<CatalogOpsResult<{ siteId: string; items: AgentProductListItem[]; nextCursor: string | null; total: number }>> {
  const { siteId, ...query } = input;
  return run(caller, siteId, 'viewSite', deps, async ({ scope, siteId: site }) => {
    const page = await listProducts(scope, { ...query, site });
    return { siteId: site, items: page.items.map(listItemView), nextCursor: page.nextCursor, total: page.total };
  });
}

/** One product of the site, with its options, variants, prices and stock; `not_found` when the site does not show it. */
export async function getSiteProduct(
  caller: SiteOpsCaller,
  input: { siteId: string; productId: string },
  deps: CatalogOpsDeps = {},
): Promise<CatalogOpsResult<{ siteId: string; product: AgentProduct }>> {
  return run(caller, input.siteId, 'viewSite', deps, async ({ scope, siteId: site }) => {
    const product = await getProduct(scope, input.productId);
    if (product.hiddenSiteIds.includes(site)) throw notFound('product', input.productId);
    return { siteId: site, product: productView(product) };
  });
}
