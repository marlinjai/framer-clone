// src/app/api/books/imports/[id]/confirm/route.ts
//
// POST /api/books/imports/<id>/confirm -> { item, documentId, counterRaisedTo }   body { expectedVersion }
//
// Import one checked row through the import core (origin `upload_extracted`,
// the counter raised past the number, upwards only). The row is validated
// again first: a blocking problem answers 422 `import_not_ready`
// naming the problem codes, and nothing is imported. A failed import leaves the
// row ready with the failure named on it.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { confirmItem } from '@/server/books/upload/service';
import { importItemView } from '@/server/books/upload/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ expectedVersion: z.number().int().min(0) }).strict();

export const POST = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const raw = await readObject(req);
  if (!raw.ok) return raw.response;
  const parsed = body.safeParse(raw.body);
  if (!parsed.success) return jsonError('bad_body', 'invalid request body', 400);
  const result = await confirmItem(ctx.scope, ctx.contactBook, id, parsed.data);
  console.info(`[books-import] item ${id}: imported${result.counterRaisedTo ? ', counter raised' : ''}`);
  return Response.json({ item: importItemView(result.item), documentId: result.documentId, counterRaisedTo: result.counterRaisedTo });
});
