// src/app/api/catalog/collections/[id]/products/route.ts
//
// PUT /api/catalog/collections/<id>/products { productIds } -> CollectionDetail
//
// The collection lists exactly these products of the company, in this order.

import { jsonError } from '@/lib/api/respond';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { setCollectionProducts } from '@/server/catalog/repository/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = catalogRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  if (!Array.isArray(body.body.productIds)) return jsonError('invalid_input', 'send { productIds: [...] }', 422);
  return Response.json(await setCollectionProducts(ctx.scope, (await params).id, body.body.productIds as string[]));
});
