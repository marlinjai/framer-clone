// src/app/api/books/documents/[id]/issue/route.ts
//
// POST /api/books/documents/<id>/issue  { expectedVersion?, issueDate? }
//   -> { document: DocumentDetail, alreadyIssued, render }
//
// Issue a draft invoice (Books plan P1.6): read the recipient from the shared
// contacts database, freeze the customer and sender snapshots, recompute every
// figure from the inputs, allocate the next number of the company's series and
// write the `issued` event, all in one transaction. The editor sends the
// `expectedVersion` the user confirmed; a change made elsewhere since answers
// 409 `concurrent_edit` and issues nothing.
//
// Idempotent: the document id is the key. A retry after a lost answer, or a
// second click, returns the same number with `alreadyIssued: true`; no call ever
// allocates a second number for one document. A refusal (no customer, no
// billable line, an incomplete recipient or sender, the contacts database
// unreachable) writes nothing and consumes no number: the document stays a
// draft and a retry gets the number the failed attempt would have had.
//
// The document of record (the PDF) is rendered from the frozen data, checked
// (every field drawable in the document font, every legally required field
// present) and stored INSIDE the issue transaction (src/server/books/render).
// If that fails, nothing is issued: 422 `undrawable_text` or
// `render_incomplete` names the fields, the document stays a draft and no
// number is taken.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { issue } from '@/server/books/issue';
import { getDocument } from '@/server/books/repository/read';
import { storeBeforeCommit } from '@/server/books/render/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const issueBody = z
  .object({
    expectedVersion: z.number().int().min(0).optional(),
    issueDate: z.string().optional(),
  })
  .strict();

export const POST = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = issueBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const result = await issue(
    ctx.scope,
    id,
    { ...parsed.data, actorUserId: ctx.userId },
    { beforeCommit: storeBeforeCommit(ctx.scope) },
  );
  // Re-read after the commit: the view carries the stored file's id.
  const view = await getDocument(ctx.scope, id);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  const fileId = view.document.renderedPdfFileId;
  return Response.json({
    document: detail,
    alreadyIssued: result.alreadyIssued,
    render: { stored: fileId !== null, fileId },
  });
});
