// src/app/api/catalog/collections/[id]/route.ts
//
// GET   /api/catalog/collections/<id> -> CollectionDetail (with its products in order)
// PATCH /api/catalog/collections/<id> -> CollectionDetail
//
// PATCH any of: title, handle, description or descriptionFormat, imageSha256
// (a stored image of the company, or null), archived. An unarchive whose
// handle a live collection took answers 409.

import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { getCollection, updateCollection, type UpdateCollectionInput } from '@/server/catalog/repository/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = catalogRoute<Params>('read', async (ctx, _req, { params }) => Response.json(await getCollection(ctx.scope, (await params).id)));

export const PATCH = catalogRoute<Params>('write', async (ctx, req, { params }) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  return Response.json(await updateCollection(ctx.scope, (await params).id, body.body as UpdateCollectionInput));
});
