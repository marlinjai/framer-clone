// src/app/api/catalog/products/route.ts
//
// GET  /api/catalog/products?q&status&type&collection&stock&sort&dir&cursor&limit -> { items, nextCursor, total }
// POST /api/catalog/products                                                        -> 201 ProductDetail
//
// The active company's products for the catalogue table (catalogue design,
// slice 2). GET: `q` matches title, type, tags, description and SKUs (folded,
// every word); `status` draft, published, archived or all (default: every
// unarchived product); `type` exact; `collection` an id; `stock` in_stock,
// out_of_stock or untracked; `sort` updated (default), title, created, price or
// stock with `dir` asc or desc; `limit` 1 to 100 (50); `cursor` from the last
// page (bound to its sort). POST: `title` required, `kind` physical (default)
// or service, `status` draft (default) or published, `productType`, `price`
// (cents). Guard chain and status codes: src/server/catalog/http.

import type { ProductListQuery } from '@/lib/catalog/types';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
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
  // The repository validates every parameter (INVALID_INPUT, 422, names the offending ones).
  return Response.json(await listProducts(ctx.scope, query as ProductListQuery));
});

export const POST = catalogRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  return Response.json(await createProduct(ctx.scope, body.body as Parameters<typeof createProduct>[1]), { status: 201 });
});
