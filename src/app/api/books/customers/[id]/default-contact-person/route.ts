// src/app/api/books/customers/[id]/default-contact-person/route.ts
//
// PUT /api/books/customers/<id>/default-contact-person  { contactPersonId: <contact id> | null } -> CustomerView
//
// The person a new draft for this customer is addressed to (it can be changed or removed on each draft). Only a
// person with an open affiliation to the customer's business: 404 `contact_person_not_found` otherwise (also for a
// person of another company). null clears it. Rights: `editBooks`.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { customerViews } from '@/server/books/http/views';
import { setCustomerDefaultContactPerson } from '@/server/books/repository/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const putBody = z.object({ contactPersonId: z.string().min(1).nullable() }).strict();

export const PUT = booksRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = putBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const customer = await setCustomerDefaultContactPerson(ctx.scope, id, parsed.data.contactPersonId);
  const [view] = await customerViews(ctx.contactBook, ctx.companyId, [customer]);
  return Response.json(view);
});
