// src/app/api/books/customers/[id]/contact-persons/route.ts
//
// GET  /api/books/customers/<id>/contact-persons -> { items: ContactPersonView[] }
// POST /api/books/customers/<id>/contact-persons -> 201 ContactPersonView
//        { contactId: <an existing person> } or { person: { name } } (a new person), plus { role? }
//
// The people at a business customer: persons of the shared contacts database with an OPEN affiliation to the
// customer's business, each with the role they hold there. POST makes a person one in a single step (creating the
// person when `person` is given; no mail address or phone is taken). 409 `duplicate_contact` for a new person whose
// name exists (`existingContactId`), 409 `duplicate_contact_person` for one that already is, 422
// `recipient_not_found` for a person that is not a contact of the company. A consumer customer (a person) has none:
// 422 `invalid_input`. Rights: `viewBooks` to read, `editBooks` to add.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { BooksError } from '@/server/books/errors';
import { booksRoute, readObject } from '@/server/books/http/route';
import { getCustomer } from '@/server/books/repository/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

const postBody = z
  .object({
    contactId: z.string().min(1).optional(),
    person: z.object({ name: z.string().trim().min(1).max(120) }).strict().optional(),
    role: z.string().trim().max(160).nullable().optional(),
  })
  .strict()
  .refine((b) => (b.contactId === undefined) !== (b.person === undefined), 'give either contactId or person');

export const GET = booksRoute<Params>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  const customer = await getCustomer(ctx.scope, id);
  const items = await ctx.contactBook.listContactPersons(ctx.companyId, customer.contactId);
  return Response.json({ items });
});

export const POST = booksRoute<Params>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = postBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const customer = await getCustomer(ctx.scope, id);
  if (customer.customerType !== 'b2b') {
    throw new BooksError('INVALID_INPUT', 'INVALID_INPUT: a consumer customer has no contact persons', {
      issues: [{ path: 'customerType', message: 'contact persons belong to a business customer' }],
    });
  }
  const item = await ctx.contactBook.addContactPerson(ctx.companyId, {
    organizationContactId: customer.contactId,
    ...(parsed.data.contactId !== undefined ? { personContactId: parsed.data.contactId } : { person: parsed.data.person! }),
    role: parsed.data.role ?? null,
  });
  return Response.json(item, { status: 201 });
});
