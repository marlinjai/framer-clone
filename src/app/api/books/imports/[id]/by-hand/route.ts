// src/app/api/books/imports/[id]/by-hand/route.ts
//
// POST /api/books/imports/<id>/by-hand -> ImportItemView   body { expectedVersion }
//
// Fill in a row by hand when the model has no reading of it (it declined, the
// invoice was too long, the output was unusable, or the daily ceiling was
// reached): the row gets an empty manual reading the user then corrects like
// any other. No model call is made.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { enterByHand } from '@/server/books/upload/service';
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
  return Response.json(importItemView(await enterByHand(ctx.scope, ctx.contactBook, id, parsed.data)));
});
