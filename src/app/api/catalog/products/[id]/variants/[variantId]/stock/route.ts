// src/app/api/catalog/products/[id]/variants/[variantId]/stock/route.ts
//
// PUT /api/catalog/products/<id>/variants/<variantId>/stock { available } -> ProductDetail
//
// Set the variant's available units through the stock ledger (one adjust
// movement for the difference, src/server/catalog/repository/stock.ts).
// 422 stock_not_tracked or sku_required when the variant cannot hold stock,
// 409 stock_below_reserved when open orders hold more than that.

import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { setVariantStock } from '@/server/catalog/repository/stock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = catalogRoute<{ id: string; variantId: string }>('write', async (ctx, req, { params }) => {
  const { id, variantId } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  return Response.json(await setVariantStock(ctx.scope, id, variantId, body.body.available as number));
});
