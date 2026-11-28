// src/app/api/catalog/products/samples/route.ts
//
// POST /api/catalog/products/samples -> { items: ProductDetail[] }
//
// "Add sample products" on the empty catalogue: three invented jewellery-shop
// products of the active company (a ring with options, a necklace, a service),
// all drafts, in the catalogue of the site the body names (`siteId`, or null for
// company items; src/server/catalog/http/site.ts verifies it). Idempotent:
// samples that catalogue has already are answered as they are.

import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { placementFrom } from '@/server/catalog/http/site';
import { addSampleProducts } from '@/server/catalog/repository/samples';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = catalogRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  return Response.json({ items: await addSampleProducts(ctx.scope, await placementFrom(ctx, body.body)) });
});
