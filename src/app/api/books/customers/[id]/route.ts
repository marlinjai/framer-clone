// src/app/api/books/customers/[id]/route.ts
//
// GET    /api/books/customers/<id>  -> CustomerView
// PATCH  /api/books/customers/<id>  -> CustomerView  (tax fields only)
// DELETE /api/books/customers/<id>  -> CustomerView  (archives; never deletes)
//
// PATCH changes the customer's tax fields (`customerType`, `vatId`,
// `countryCode`, `taxNumber`); name and address are the contact's and are
// edited in the contacts app. Drafts of this customer pick the change up on
// their next change or at issue (their stored tax profile key no longer
// matches, Books plan P1.4), and the document editor shows them as stale until
// then. DELETE archives: issued documents keep pointing at the customer, so it
// is never removed; an archived customer can no longer be put on a draft.
// Another company's id answers 404.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { customerViews } from '@/server/books/http/views';
import { archiveCustomer, getCustomer, updateCustomerTaxFields } from '@/server/books/repository/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

const patchBody = z
  .object({
    customerType: z.enum(['b2c', 'b2b']).optional(),
    vatId: z.string().nullable().optional(),
    countryCode: z.string().optional(),
    taxNumber: z.string().nullable().optional(),
  })
  .strict();

export const GET = booksRoute<Params>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  const customer = await getCustomer(ctx.scope, id);
  const [view] = await customerViews(ctx.contactBook, ctx.companyId, [customer]);
  return Response.json(view);
});

export const PATCH = booksRoute<Params>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = patchBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const customer = await updateCustomerTaxFields(ctx.scope, id, parsed.data);
  const [view] = await customerViews(ctx.contactBook, ctx.companyId, [customer]);
  return Response.json(view);
});

export const DELETE = booksRoute<Params>('write', async (ctx, _req, { params }) => {
  const { id } = await params;
  const customer = await archiveCustomer(ctx.scope, id);
  const [view] = await customerViews(ctx.contactBook, ctx.companyId, [customer]);
  return Response.json(view);
});
