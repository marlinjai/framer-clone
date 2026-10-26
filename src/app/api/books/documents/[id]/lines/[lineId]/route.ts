// src/app/api/books/documents/[id]/lines/[lineId]/route.ts
//
// PATCH  /api/books/documents/<id>/lines/<lineId>  -> DocumentDetail
// DELETE /api/books/documents/<id>/lines/<lineId>[?expectedVersion=n]
//                                                  -> DocumentDetail
//
// Edit or remove one line of a draft. An edit recomputes only that line and the
// document totals (the other lines are not rewritten); a removal closes the
// position gap. Both take `expectedVersion` (PATCH in the body, DELETE as a
// query parameter, since a DELETE carries no body); a stale one answers 409.
// PATCH may pick another catalogue item into the line: `variantRef` (the
// company's own variant, else 404 variant_not_found) with the copied values,
// and `priceBasis` with the `unitPrice` it qualifies (converted to the draft's
// basis as on POST); `variantRef: null` drops the reference.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { lineFieldsBody } from '@/server/books/http/bodies';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { removeLine, updateLine } from '@/server/books/repository/lines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string; lineId: string };

const patchBody = z
  .object({ ...lineFieldsBody, variantRef: z.string().min(1).nullable().optional(), priceBasis: z.enum(['net', 'gross']).optional() })
  .strict();

export const PATCH = booksRoute<Params>('write', async (ctx, req, { params }) => {
  const { id, lineId } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = patchBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const view = await updateLine(ctx.scope, id, lineId, parsed.data);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json(detail);
});

export const DELETE = booksRoute<Params>('write', async (ctx, req, { params }) => {
  const { id, lineId } = await params;
  const raw = new URL(req.url).searchParams.get('expectedVersion');
  let expectedVersion: number | undefined;
  if (raw !== null) {
    expectedVersion = Number(raw);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return jsonError('bad_query', 'expectedVersion must be a non-negative integer', 400);
    }
  }
  const view = await removeLine(ctx.scope, id, lineId, { expectedVersion });
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json(detail);
});
