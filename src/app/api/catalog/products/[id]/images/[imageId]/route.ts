// src/app/api/catalog/products/[id]/images/[imageId]/route.ts
//
// PATCH  /api/catalog/products/<id>/images/<imageId> { alt } -> ProductDetail
// DELETE /api/catalog/products/<id>/images/<imageId>         -> ProductDetail
//
// One image placed on the product: its alternative text, or taking it off the
// product (the stored file stays, so adding it again is instant).

import { jsonError } from '@/lib/api/respond';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { removeProductImage, setImageAlt } from '@/server/catalog/repository/images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string; imageId: string };

export const PATCH = catalogRoute<Params>('write', async (ctx, req, { params }) => {
  const { id, imageId } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  if (!('alt' in body.body)) return jsonError('invalid_input', 'send { alt }', 422);
  return Response.json(await setImageAlt(ctx.scope, id, imageId, body.body.alt as string | null));
});

export const DELETE = catalogRoute<Params>('write', async (ctx, _req, { params }) => {
  const { id, imageId } = await params;
  return Response.json(await removeProductImage(ctx.scope, id, imageId));
});
