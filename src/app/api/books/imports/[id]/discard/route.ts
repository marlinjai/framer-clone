// src/app/api/books/imports/[id]/discard/route.ts
//
// POST /api/books/imports/<id>/discard -> ImportItemView
//
// Set a staged row aside (any status but imported). It leaves the review
// table and its bytes are cleared at once; uploading the same file again
// stages it again.

import { booksRoute } from '@/server/books/http/route';
import { discardItem } from '@/server/books/upload/service';
import { importItemView } from '@/server/books/upload/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = booksRoute<{ id: string }>('write', async (ctx, _req, { params }) => {
  const { id } = await params;
  return Response.json(importItemView(await discardItem(ctx.scope, id)));
});
