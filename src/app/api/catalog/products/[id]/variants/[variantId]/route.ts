// src/app/api/catalog/products/[id]/variants/[variantId]/route.ts
//
// PATCH /api/catalog/products/<id>/variants/<variantId> -> ProductDetail
//
// One variant: any of sku, barcode, price, compareAt (cents or null),
// manageInventory, allowBackorder, imageId (one of the product's image links,
// or null). A SKU or barcode in use answers 409.

import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { updateVariant, type VariantInput } from '@/server/catalog/repository/variants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = catalogRoute<{ id: string; variantId: string }>('write', async (ctx, req, { params }) => {
  const { id, variantId } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  return Response.json(await updateVariant(ctx.scope, id, variantId, body.body as VariantInput));
});
