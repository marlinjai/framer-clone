// src/app/api/books/documents/[id]/lines/reorder/route.ts
//
// POST /api/books/documents/<id>/lines/reorder  { lineIds, expectedVersion? }
//   -> DocumentDetail
//
// Put a draft's lines in the given order (positions 1..n). `lineIds` must be
// exactly the draft's line ids, each once (400 `invalid_positions` otherwise).

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { reorderLines } from '@/server/books/repository/lines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reorderBody = z
  .object({
    lineIds: z.array(z.string().min(1)).max(500),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export const POST = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = reorderBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const view = await reorderLines(ctx.scope, id, parsed.data);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json(detail);
});
