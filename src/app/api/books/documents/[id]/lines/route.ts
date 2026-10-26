// src/app/api/books/documents/[id]/lines/route.ts
//
// POST /api/books/documents/<id>/lines  -> 201 DocumentDetail
//
// Append a line to a draft (Books plan P1.6, addLine). Body: `kind` (service,
// product or text), `title`, optional `description`, `quantity` in THOUSANDTHS
// (1.5 hours = 1500), `unitLabel`, `unitPrice` in cents, `discountBp` in basis
// points, `taxClass` (standard, reduced, zero) or `taxRateOverride` in basis
// points, or a catalogue `variantRef` (kept as the line's reference) that fills
// the title, price and tax class the body leaves out; `priceBasis` ('net' or
// 'gross', a catalogue item's)
// when the price is quoted in another basis than the draft's: the server then
// converts it under the draft's tax profile and stores it in the draft's basis;
// plus `expectedVersion`. The line's tax and the document
// totals are derived on the server; the answer is the whole recomputed
// document. A text line carries no quantity, price or tax.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { lineFieldsBody } from '@/server/books/http/bodies';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { addLine } from '@/server/books/repository/lines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const addBody = z
  .object({ ...lineFieldsBody, variantRef: z.string().min(1).optional(), priceBasis: z.enum(['net', 'gross']).optional() })
  .strict();

export const POST = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = addBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const view = await addLine(ctx.scope, id, parsed.data);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json(detail, { status: 201 });
});
