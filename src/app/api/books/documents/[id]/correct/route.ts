// src/app/api/books/documents/[id]/correct/route.ts
//
// POST /api/books/documents/<id>/correct  {}
//   -> { document: DocumentDetail, existing }
//
// "Korrigieren" (the Correct flow, plan
// docs/plans/2026-10-21-books-visual-template-composer.md, decision 9): an
// issued invoice is never edited. This creates a replacement DRAFT prefilled
// with the invoice's customer, lines and texts, pointing at the invoice; nothing
// is cancelled yet. Issuing the draft (POST .../issue) cancels the old invoice
// through a credit note and issues the replacement in one transaction, so an
// abandoned draft cancels nothing.
//
// Idempotent per invoice: an invoice that already has a replacement answers
// that draft with `existing: true`. Only an issued, not cancelled invoice made
// in the editor can be corrected; anything else is 409 `not_correctable`
// (cancel an imported invoice and create a new one instead).

import { jsonError } from '@/lib/api/respond';
import { startCorrection } from '@/server/books/correct';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { getDocument } from '@/server/books/repository/read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  if (Object.keys(body.body).length > 0) {
    return jsonError('bad_body', 'this request takes no fields', 400);
  }
  const result = await startCorrection(ctx.scope, id, { actorUserId: ctx.userId });
  const view = await getDocument(ctx.scope, result.document.document.id);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json({ document: detail, existing: result.existing }, { status: result.existing ? 200 : 201 });
});
