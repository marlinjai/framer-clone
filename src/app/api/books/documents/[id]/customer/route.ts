// src/app/api/books/documents/[id]/customer/route.ts
//
// PUT /api/books/documents/<id>/customer  { customerId, expectedVersion? }
//   -> DocumentDetail
//
// Put a customer on a draft: the BACKTRACK-AND-REVISE path of the editor
// (stateful-flow standard, path 2). The customer's tax profile (business or
// consumer, VAT id, country, plus the company's tax status) is the key of every
// derived tax figure: when the swap changes it, every line's rate, tax and
// treatment and the document totals, tax summary and tax note are recomputed
// from the lines' stored inputs (a swap to an EU business under regular
// taxation turns every line into reverse charge; swapping back restores the
// 19 and 7 percent from the inputs). When the key stays the same (another
// German consumer), no line is touched. The same customer again is a no-op.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { setCustomer } from '@/server/books/repository/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const putBody = z
  .object({
    customerId: z.string().min(1),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export const PUT = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = putBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const view = await setCustomer(ctx.scope, id, { ...parsed.data, actorUserId: ctx.userId });
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json(detail);
});
