// src/app/api/books/documents/[id]/cancel/route.ts
//
// POST /api/books/documents/<id>/cancel  { reason, issueDate? }
//   -> { invoice: DocumentDetail, creditNote: DocumentDetail, alreadyCancelled, render }
//
// Cancel an issued invoice the only legal way: a credit note that references it
// and offsets it in full, numbered from the company's own credit note series
// (Books plan P1.6, cancelInvoice). The invoice is never mutated beyond its
// status; the database refuses a cancellation without the credit note. The
// credit note copies the invoice's recipient snapshot, so a cancellation never
// depends on the contacts database. `reason` is a short business reason
// written into the audit trail (at most 200 characters, no personal data).
// Idempotent: a second call returns the existing credit note with
// `alreadyCancelled: true`. A draft answers 409 `not_cancellable`.
//
// The credit note's PDF is rendered and stored right after, like an issued
// invoice's (a failure there never undoes the cancellation).

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { cancelInvoice } from '@/server/books/cancel';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { getDocument } from '@/server/books/repository/read';
import { storeRenderedDocument } from '@/server/books/render/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cancelBody = z
  .object({
    reason: z.string(),
    issueDate: z.string().optional(),
  })
  .strict();

export const POST = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = cancelBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const result = await cancelInvoice(ctx.scope, id, { ...parsed.data, actorUserId: ctx.userId });
  const creditNoteId = result.creditNote.document.id;

  let render: { stored: boolean };
  try {
    await storeRenderedDocument(ctx.scope, creditNoteId);
    render = { stored: true };
  } catch (err) {
    console.error(`[books] credit note ${creditNoteId}: rendering failed; the download retries`, err);
    render = { stored: false };
  }

  const load = (cid: string) => getCustomer(ctx.scope, cid);
  const [invoice, creditNote] = await Promise.all([
    getDocument(ctx.scope, id).then((v) => documentDetail(ctx.contactBook, ctx.companyId, v, load)),
    getDocument(ctx.scope, creditNoteId).then((v) => documentDetail(ctx.contactBook, ctx.companyId, v, load)),
  ]);
  return Response.json({ invoice, creditNote, alreadyCancelled: result.alreadyCancelled, render });
});
