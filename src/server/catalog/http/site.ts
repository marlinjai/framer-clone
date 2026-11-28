// src/server/catalog/http/site.ts
//
// The site an editor catalogue request names (a list filter, or where a new product or collection goes), verified
// (docs/plans/2026-11-27-agent-catalogue-tools.md, the catalogue per project, slice 2b). A site id from the request is
// only a selector: it is looked up in the company's own editor workspace and tenant group (the workspace the session's
// active company works in, src/server/catalog/http/route.ts), a branch resolves to its main site (the catalogue keys to
// main sites), and anything else, another company's site, a deleted or closed one, answers UNKNOWN_SITE (404). Protects
// against a member of one company naming another company's site to read or create in its catalogue.

import { SiteNotFoundError } from '@/server/sites';
import { getSiteBranchRepository } from '@/server/sites/branches/repository';
import { CatalogError, invalidField } from '../errors';
import type { CatalogRequestContext } from './route';

/** The main site id for `siteId` in the request's company, or UNKNOWN_SITE. */
export async function verifiedMainSite(ctx: Pick<CatalogRequestContext, 'workspace'>, siteId: string): Promise<string> {
  try {
    const context = await getSiteBranchRepository().siteBranchContext(ctx.workspace, siteId);
    return context.kind === 'branch' ? context.mainSiteId : context.siteId;
  } catch (err) {
    // A closed (merged or discarded) branch is a SiteNotFoundError too.
    if (err instanceof SiteNotFoundError) {
      throw new CatalogError('UNKNOWN_SITE', 'UNKNOWN_SITE: this site is not one of the company’s sites', { siteId });
    }
    throw err;
  }
}

/**
 * Where a create request puts its row: `siteId` a site of the company (its main site), or explicitly null for a company
 * item. Absent is refused (INVALID_INPUT), so a client that forgot the site never makes an item that shows on no shop.
 */
export async function placementFrom(ctx: Pick<CatalogRequestContext, 'workspace'>, body: Record<string, unknown>): Promise<{ siteId: string | null }> {
  const raw = body.siteId;
  if (raw === null) return { siteId: null };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 100) {
    throw invalidField('siteId', 'name the site the item belongs to, or null for a company item offered only to the Books');
  }
  return { siteId: await verifiedMainSite(ctx, raw) };
}
