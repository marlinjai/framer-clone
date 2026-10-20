// src/app/api/books/imports/[id]/route.ts
//
// GET   /api/books/imports/<id> -> ImportItemView
// PATCH /api/books/imports/<id> -> ImportItemView   body { printed, extractionId, expectedVersion }
//
// One staging row, and the user's correction of it from the review table: the
// corrected printed invoice, keyed to the extraction it corrects and to the
// row's version. A correction of an extraction that is no longer current is
// 409 `stale_extraction` (the invoice was read again since); a change made in
// another window is 409 `concurrent_edit`. The row is validated again and the
// answer carries its new problems and status.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { correctItem } from '@/server/books/upload/service';
import { getItem } from '@/server/books/upload/staging';
import { importItemView } from '@/server/books/upload/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchBody = z
  .object({
    printed: z.record(z.string(), z.unknown()),
    extractionId: z.string().min(1).max(100),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export const GET = booksRoute<{ id: string }>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  return Response.json(importItemView(await getItem(ctx.scope.db, ctx.scope, id)));
});

export const PATCH = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = patchBody.safeParse(body.body);
  if (!parsed.success) return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) });
  if (JSON.stringify(parsed.data.printed).length > 200_000) return jsonError('bad_body', 'the invoice is too large', 400);
  const item = await correctItem(ctx.scope, ctx.contactBook, id, parsed.data);
  return Response.json(importItemView(item));
});
