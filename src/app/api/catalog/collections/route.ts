// src/app/api/catalog/collections/route.ts
//
// GET  /api/catalog/collections[?includeArchived=1][&site=<id> | &companyItems=1] -> { items: CollectionView[] }
// POST /api/catalog/collections { title, siteId }                -> 201 CollectionDetail
//
// The active company's collections by title (live ones; archived too with
// includeArchived=1), only one site's catalogue with `site`, only those
// without a site with `companyItems=1`. A new
// collection's handle comes from its title; `siteId` names its site (or null
// for a company item; required). Sites are verified by
// src/server/catalog/http/site.ts.

import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { placementFrom, verifiedMainSite } from '@/server/catalog/http/site';
import { createCollection, listCollections } from '@/server/catalog/repository/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = catalogRoute('read', async (ctx, req) => {
  const params = new URL(req.url).searchParams;
  const includeArchived = params.get('includeArchived') === '1';
  const site = params.get('site');
  const siteId = site !== null && site !== '' ? await verifiedMainSite(ctx, site) : params.get('companyItems') === '1' ? null : undefined;
  return Response.json({ items: await listCollections(ctx.scope, { includeArchived, siteId }) });
});

export const POST = catalogRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const { siteId, ...input } = body.body;
  return Response.json(await createCollection(ctx.scope, input as { title: string }, await placementFrom(ctx, { siteId })), { status: 201 });
});
