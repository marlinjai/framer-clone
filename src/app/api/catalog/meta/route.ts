// src/app/api/catalog/meta/route.ts
//
// GET /api/catalog/meta -> { sites: SiteView[], productTypes: string[], assigned: boolean }
//
// What the catalogue's site picker, filters and the panel offer: the active
// company's main sites (its editor workspace's), the product types it uses, and
// whether its catalogue has been assigned to its sites (catalogue_per_site,
// src/server/commerce/repository/siteCatalogue.ts): before that, products
// without a site still show on every site unless switched off there.

import { catalogRoute } from '@/server/catalog/http/route';
import { listProductTypes } from '@/server/catalog/repository/products';
import { getSiteRepository } from '@/server/sites';
import { isCatalogueAssigned } from '@/server/commerce/repository/siteCatalogue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = catalogRoute('read', async (ctx) => {
  const [sites, productTypes, assigned] = await Promise.all([
    getSiteRepository().listSites(ctx.workspace),
    listProductTypes(ctx.scope),
    isCatalogueAssigned(ctx.scope.db, ctx.scope.tenantId),
  ]);
  return Response.json({ sites: sites.map((s) => ({ id: s.siteId, name: s.name })), productTypes, assigned });
});
