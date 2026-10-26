// src/app/api/catalog/products/bulk/route.ts
//
// POST /api/catalog/products/bulk -> { changed }
//
// One action on the selected products of the table, all or nothing:
//   { action: 'status', ids, status: 'draft' | 'published' }   (also clears an archive)
//   { action: 'archive' | 'unarchive', ids }
//   { action: 'addToCollection', ids, collectionId }          (appends the ones not in it)
// At most 200 ids; one that is not the company's live product answers 404 and
// nothing changes.

import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { bulkProducts, type BulkInput } from '@/server/catalog/repository/products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = catalogRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  return Response.json(await bulkProducts(ctx.scope, body.body as BulkInput));
});
