// src/app/api/books/documents/[id]/route.ts
//
// GET   /api/books/documents/<id>  -> DocumentDetail
// PATCH /api/books/documents/<id>  -> DocumentDetail  (a draft's header fields)
//
// GET is the RESUME path of the editor (stateful-flow standard, path 3): the
// editor keeps no state of its own beyond the last answer, so a reload is this
// read. For a draft whose stored tax figures were computed under a tax profile
// that no longer matches its customer and the company setting (the customer's
// VAT id or country changed meanwhile), the answer carries the recomputed
// figures and `stale: true`, never the stored ones as current; the next change
// or the issue persists them (Books plan P1.6).
//
// PATCH edits a draft's header: `templateId`, `netOrGross`, `serviceDate`,
// `servicePeriod`, `paymentTermsDays`, `contractReference`, `introText`,
// `outroText`, and `replacesDocumentId: null` (a replacement draft of the
// Correct flow becomes an ordinary invoice: issuing it then cancels nothing).
// Pass `expectedVersion` (the `document.version` the editor
// shows); a stale one answers 409 `concurrent_edit` and changes nothing.
// The customer is set through PUT .../customer (it re-derives the tax).

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { updateDraft } from '@/server/books/repository/documents';
import { getDocument } from '@/server/books/repository/read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

const patchBody = z
  .object({
    expectedVersion: z.number().int().min(0).optional(),
    templateId: z.string().min(1).nullable().optional(),
    netOrGross: z.enum(['net', 'gross']).optional(),
    serviceDate: z.string().nullable().optional(),
    servicePeriod: z.object({ start: z.string(), end: z.string() }).nullable().optional(),
    paymentTermsDays: z.number().int().optional(),
    contractReference: z.string().nullable().optional(),
    introText: z.string().nullable().optional(),
    outroText: z.string().nullable().optional(),
    replacesDocumentId: z.null().optional(),
  })
  .strict();

export const GET = booksRoute<Params>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  const view = await getDocument(ctx.scope, id);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json(detail);
});

export const PATCH = booksRoute<Params>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = patchBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const view = await updateDraft(ctx.scope, id, parsed.data);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json(detail);
});
