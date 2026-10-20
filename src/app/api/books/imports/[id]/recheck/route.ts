// src/app/api/books/imports/[id]/recheck/route.ts
//
// POST /api/books/imports/<id>/recheck -> ImportItemView
//
// Validate a staged row again without changing it: after the contacts database
// answered again, the counter moved, or another row with the same number was
// discarded.

import { booksRoute } from '@/server/books/http/route';
import { recheckItem } from '@/server/books/upload/service';
import { importItemView } from '@/server/books/upload/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = booksRoute<{ id: string }>('write', async (ctx, _req, { params }) => {
  const { id } = await params;
  return Response.json(importItemView(await recheckItem(ctx.scope, ctx.contactBook, id)));
});
