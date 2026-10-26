// src/app/api/catalog/products/samples/route.ts
//
// POST /api/catalog/products/samples -> { items: ProductDetail[] }
//
// "Add sample products" on the empty catalogue: three invented jewellery-shop
// products of the active company (a ring with options, a necklace, a service),
// all drafts. Idempotent: samples the company has already are answered as they are.

import { catalogRoute } from '@/server/catalog/http/route';
import { addSampleProducts } from '@/server/catalog/repository/samples';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = catalogRoute('write', async (ctx) => Response.json({ items: await addSampleProducts(ctx.scope) }));
