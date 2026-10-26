// src/app/api/catalog/collections/route.ts
//
// GET  /api/catalog/collections[?includeArchived=1] -> { items: CollectionView[] }
// POST /api/catalog/collections { title }           -> 201 CollectionDetail
//
// The active company's collections by title (live ones; archived too with
// includeArchived=1). A new collection's handle comes from its title.

import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { createCollection, listCollections } from '@/server/catalog/repository/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = catalogRoute('read', async (ctx, req) => {
  const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1';
  return Response.json({ items: await listCollections(ctx.scope, { includeArchived }) });
});

export const POST = catalogRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  return Response.json(await createCollection(ctx.scope, body.body as { title: string }), { status: 201 });
});
