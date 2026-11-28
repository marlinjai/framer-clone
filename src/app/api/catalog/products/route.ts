// src/app/api/catalog/products/route.ts
//
// GET  /api/catalog/products?q&status&type&collection&stock&sort&dir&cursor&limit -> { items, nextCursor, total }
// POST /api/catalog/products                                                        -> 201 ProductDetail
//
// The active company's products for the catalogue table (catalogue design,
// slice 2), per site since the catalogue per project (033): GET `site` (a site
// of the company, a branch reads its main site) lists that site's catalogue,
// `companyItems=1` the items without a site; POST takes `siteId` (a site of the
// company, or null for a company item; required). Sites are verified by
// src/server/catalog/http/site.ts. GET: `q` matches title, type, tags, description and SKUs (folded,
// every word); `status` draft, published, archived or all (default: every
// unarchived product); `type` exact; `collection` an id; `stock` in_stock,
// out_of_stock or untracked; `sort` updated (default), title, created, price or
// stock with `dir` asc or desc; `limit` 1 to 100 (50); `cursor` from the last
// page (bound to its sort). POST: `title` required, `kind` physical (default)
// or service, `status` draft (default) or published, `productType`, `price`
// (cents). Guard chain and status codes: src/server/catalog/http.

import type { ProductListQuery } from '@/lib/catalog/types';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { placementFrom, verifiedMainSite } from '@/server/catalog/http/site';
import { createProduct, listProducts } from '@/server/catalog/repository/products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = catalogRoute('read', async (ctx, req) => {
  const params = new URL(req.url).searchParams;
  const query: Record<string, unknown> = {};
  for (const key of ['q', 'status', 'type', 'collection', 'stock', 'sort', 'dir', 'cursor'] as const) {
    const value = params.get(key);
    if (value !== null && value !== '') query[key] = value;
  }
  const limit = params.get('limit');
  if (limit !== null) query.limit = /^\d+$/.test(limit) ? Number(limit) : limit;
  const site = params.get('site');
  if (site !== null && site !== '') query.site = await verifiedMainSite(ctx, site);
  if (params.get('companyItems') === '1') query.companyItems = true;
  // The repository validates every parameter (INVALID_INPUT, 422, names the offending ones).
  return Response.json(await listProducts(ctx.scope, query as ProductListQuery));
});

export const POST = catalogRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const { siteId, ...input } = body.body;
  const placement = await placementFrom(ctx, { siteId });
  return Response.json(await createProduct(ctx.scope, input as Parameters<typeof createProduct>[1], placement), { status: 201 });
});
