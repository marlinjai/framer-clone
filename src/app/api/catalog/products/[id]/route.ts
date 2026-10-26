// src/app/api/catalog/products/[id]/route.ts
//
// GET   /api/catalog/products/<id> -> ProductDetail
// PATCH /api/catalog/products/<id> -> ProductDetail
//
// One product of the active company (another company's id answers 404). PATCH
// takes ONE kind of change per request:
//   { archived: boolean }        archive or unarchive
//   { price: cents | null }      the table's inline price of a one-variant product
//   any product fields           title, handle, kind, status (draft, published,
//                                archived), productType, tags, description or
//                                descriptionFormat, taxClass, priceBasis,
//                                unitLabel, discountBp, seoTitle, seoDescription

import { jsonError } from '@/lib/api/respond';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { getProduct, setArchived, setSinglePrice, updateProduct } from '@/server/catalog/repository/products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = catalogRoute<Params>('read', async (ctx, _req, { params }) => Response.json(await getProduct(ctx.scope, (await params).id)));

export const PATCH = catalogRoute<Params>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const keys = Object.keys(body.body);
  if (keys.includes('archived')) {
    if (keys.length !== 1 || typeof body.body.archived !== 'boolean') {
      return jsonError('invalid_input', 'send { archived: true } or { archived: false } on its own', 422);
    }
    return Response.json(await setArchived(ctx.scope, id, body.body.archived));
  }
  if (keys.includes('price')) {
    if (keys.length !== 1) return jsonError('invalid_input', 'send the inline price on its own', 422);
    return Response.json(await setSinglePrice(ctx.scope, id, body.body.price as number | null));
  }
  return Response.json(await updateProduct(ctx.scope, id, body.body as Parameters<typeof updateProduct>[2]));
});
