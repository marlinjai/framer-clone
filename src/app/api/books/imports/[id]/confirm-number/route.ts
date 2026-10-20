// src/app/api/books/imports/[id]/confirm-number/route.ts
//
// POST /api/books/imports/<id>/confirm-number -> ImportItemView   body { documentNumber, expectedVersion }
//
// The user confirms that a number jumping far ahead of the counter or of the
// other staged rows (`number_jump`) is printed that way, for exactly this
// number and version. Changing the number afterwards makes the problem return.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { confirmNumber } from '@/server/books/upload/service';
import { importItemView } from '@/server/books/upload/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ documentNumber: z.string().trim().min(1).max(40), expectedVersion: z.number().int().min(0) }).strict();

export const POST = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const raw = await readObject(req);
  if (!raw.ok) return raw.response;
  const parsed = body.safeParse(raw.body);
  if (!parsed.success) return jsonError('bad_body', 'invalid request body', 400);
  return Response.json(importItemView(await confirmNumber(ctx.scope, ctx.contactBook, id, parsed.data)));
});
