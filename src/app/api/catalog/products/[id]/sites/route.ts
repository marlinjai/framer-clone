// src/app/api/catalog/products/[id]/sites/route.ts
//
// PUT /api/catalog/products/<id>/sites { hiddenSiteIds } -> ProductDetail
//
// Hide the product on exactly these sites of the active company (every other
// site of the company shows it once it is published). A site that is not the
// company's answers 404 unknown_site.

import { jsonError } from '@/lib/api/respond';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { setHiddenSites } from '@/server/catalog/repository/sites';
import { getSiteRepository } from '@/server/sites';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = catalogRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  if (!Array.isArray(body.body.hiddenSiteIds)) return jsonError('invalid_input', 'send { hiddenSiteIds: [...] }', 422);
  const sites = await getSiteRepository().listSites(ctx.workspace);
  return Response.json(
    await setHiddenSites(ctx.scope, (await params).id, body.body.hiddenSiteIds as string[], new Set(sites.map((s) => s.siteId))),
  );
});
