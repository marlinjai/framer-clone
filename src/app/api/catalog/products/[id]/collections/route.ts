// src/app/api/catalog/products/[id]/collections/route.ts
//
// PUT /api/catalog/products/<id>/collections { collectionIds } -> ProductDetail
//
// The product's collections become exactly these (it keeps its place where it
// stays and is appended where it joins). Another company's collection: 404.

import { jsonError } from '@/lib/api/respond';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { setProductCollections } from '@/server/catalog/repository/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = catalogRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  if (!Array.isArray(body.body.collectionIds)) return jsonError('invalid_input', 'send { collectionIds: [...] }', 422);
  return Response.json(await setProductCollections(ctx.scope, (await params).id, body.body.collectionIds as string[]));
});
