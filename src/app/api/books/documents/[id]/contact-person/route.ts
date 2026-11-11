// src/app/api/books/documents/[id]/contact-person/route.ts
//
// PUT /api/books/documents/<id>/contact-person  { contactPersonId: <contact id> | null, expectedVersion? }
//   -> DocumentDetail
//
// Address a draft to a person at its customer's business ("z. Hd."), or remove them (null). Only a person with an
// OPEN affiliation to the customer's business can be chosen: 404 `contact_person_not_found` otherwise (also for a
// person of another company, so nothing about another company is confirmed), 422 `contact_person_unavailable` for an
// archived one, 422 `customer_required` for a draft without a customer. Changing the draft's customer clears the
// contact person (PUT .../customer), never keeps the previous customer's. Rights as every Books write: `editBooks`.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { documentDetail } from '@/server/books/http/views';
import { getCustomer } from '@/server/books/repository/customers';
import { setContactPerson } from '@/server/books/repository/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const putBody = z
  .object({
    contactPersonId: z.string().min(1).nullable(),
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
  const view = await setContactPerson(ctx.scope, id, parsed.data);
  const detail = await documentDetail(ctx.contactBook, ctx.companyId, view, (cid) => getCustomer(ctx.scope, cid));
  return Response.json(detail);
});
