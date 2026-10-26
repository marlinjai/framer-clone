// src/app/api/catalog/meta/route.ts
//
// GET /api/catalog/meta -> { sites: SiteView[], productTypes: string[] }
//
// What the catalogue's filters and the panel's Sites section offer: the active
// company's sites (its editor workspace's) and the product types it uses.

import { catalogRoute } from '@/server/catalog/http/route';
import { listProductTypes } from '@/server/catalog/repository/products';
import { getSiteRepository } from '@/server/sites';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = catalogRoute('read', async (ctx) => {
  const [sites, productTypes] = await Promise.all([getSiteRepository().listSites(ctx.workspace), listProductTypes(ctx.scope)]);
  return Response.json({ sites: sites.map((s) => ({ id: s.siteId, name: s.name })), productTypes });
});
