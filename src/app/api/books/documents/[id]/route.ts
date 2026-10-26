// src/app/api/books/documents/[id]/route.ts
//
// GET   /api/books/documents/<id>  -> DocumentDetail and `printsSubject`
// PATCH /api/books/documents/<id>  -> DocumentDetail and `printsSubject`  (a draft's header fields)
// DELETE /api/books/documents/<id>[?expectedVersion=n] -> 204  (a draft without a number, with its lines and events)
//
// `printsSubject` says whether the document's template prints the subject (a
// draft's current template, an issued document's frozen one), so the form can
// say where a subject goes instead of taking one that never prints.
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
// `servicePeriod`, `paymentTermsDays`, `contractReference`, `subject` (one
// line, at most 200 characters), `introText`, `outroText` (or `introFormat`,
// `outroFormat`: the formatted text, whose plain words the server derives), and `replacesDocumentId: null` (a replacement draft of the
// Correct flow becomes an ordinary invoice: issuing it then cancels nothing).
// Pass `expectedVersion` (the `document.version` the editor
// shows); a stale one answers 409 `concurrent_edit` and changes nothing.
// The customer is set through PUT .../customer (it re-derives the tax).
//
// DELETE removes a draft that never had a number (019_books_draft_delete): an
// issued document answers 409 `not_draft`, an offer that was issued once and
// went back to draft 409 `not_deletable`, a stale `expectedVersion` (a query
// parameter, since a DELETE carries no body) 409 `concurrent_edit`, and a draft
// already deleted 404. Nothing is changed by a refusal.

import { z } from 'zod';

import { richTextSchema } from '@/server/books/render/richText';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { deleteDraft, updateDraft } from '@/server/books/repository/documents';
import { getDocument } from '@/server/books/repository/read';
import { documentPrintsSubject } from '@/server/books/render/store';

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
    subject: z.string().nullable().optional(),
    introText: z.string().nullable().optional(),
    outroText: z.string().nullable().optional(),
    // A formatted text (bold, italic, bullets); the repository derives its plain text.
    introFormat: richTextSchema.optional(),
    outroFormat: richTextSchema.optional(),
    replacesDocumentId: z.null().optional(),
  })
  .strict();

export const GET = booksRoute<Params>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  const view = await getDocument(ctx.scope, id);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json({ ...detail, printsSubject: await documentPrintsSubject(ctx.scope, view) });
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
  // A template change can add or remove the subject block, so the answer says again whether it prints.
  return Response.json({ ...detail, printsSubject: await documentPrintsSubject(ctx.scope, view) });
});

export const DELETE = booksRoute<Params>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const raw = new URL(req.url).searchParams.get('expectedVersion');
  let expectedVersion: number | undefined;
  if (raw !== null) {
    expectedVersion = Number(raw);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return jsonError('bad_query', 'expectedVersion must be a non-negative integer', 400);
    }
  }
  await deleteDraft(ctx.scope, id, { expectedVersion });
  return new Response(null, { status: 204 });
});
