// src/app/api/books/customers/route.ts
//
// GET  /api/books/customers[?includeArchived=1&cursor=...]  -> { items, nextCursor, total }
// POST /api/books/customers                                  -> 201 CustomerView
//
// The active company's customers (Books plan P1.2, phase 2). A customer row
// holds the tax fields; name and address come from the shared contacts
// database, so every item carries its contact label (or `contactStatus:
// 'unavailable'` when that database cannot be read: the list still answers).
//
// POST takes either an existing contact (`contactId`, picked through
// GET /api/books/contacts) or a new one (`contact: { kind, name, address... }`,
// created in the shared contacts database first, then the customer for it).
// The tax fields: `customerType` (b2c or b2b), optional `vatId`, `countryCode`
// and `taxNumber`; an omitted VAT id or country is prefilled once from the
// contact. Guard chain and status codes: src/server/books/http/route.ts and
// errorResponse.ts.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { customerView, customerViews } from '@/server/books/http/views';
import { createCustomer, listCustomers } from '@/server/books/repository/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const text = (max: number) => z.string().trim().max(max).nullable().optional();

const newContact = z.object({
  kind: z.enum(['person', 'organization']),
  name: z.string().trim().min(1).max(200),
  companyOrRole: text(200),
  legalForm: text(60),
  email: text(200),
  addressLine1: text(200),
  addressLine2: text(200),
  postalCode: text(20),
  city: text(100),
  country: text(2),
  vatId: text(20),
});

const createBody = z
  .object({
    contactId: z.string().min(1).optional(),
    contact: newContact.optional(),
    customerType: z.enum(['b2c', 'b2b']),
    vatId: z.string().nullable().optional(),
    countryCode: z.string().optional(),
    taxNumber: z.string().nullable().optional(),
  })
  .strict()
  .refine((b) => (b.contactId === undefined) !== (b.contact === undefined), {
    message: 'give exactly one of contactId (an existing contact) or contact (a new one)',
    path: ['contactId'],
  });

export const GET = booksRoute('read', async (ctx, req) => {
  const url = new URL(req.url);
  const page = await listCustomers(ctx.scope, {
    includeArchived: url.searchParams.get('includeArchived') === '1',
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: 100,
  });
  const items = await customerViews(ctx.contactBook, ctx.companyId, page.items);
  return Response.json({ items, nextCursor: page.nextCursor, total: page.total });
});

export const POST = booksRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = createBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const args = parsed.data;

  // A new contact is created in the shared contacts database first. When the
  // customer insert then fails (an invalid VAT id, say), the contact stays: it
  // is a valid contact of the company, and the retry picks it by id.
  const contactId = args.contactId ?? (await ctx.contactBook.create(ctx.companyId, args.contact!)).id;

  const customer = await createCustomer(ctx.scope, {
    contactId,
    customerType: args.customerType,
    ...(args.vatId !== undefined ? { vatId: args.vatId } : {}),
    ...(args.countryCode !== undefined ? { countryCode: args.countryCode } : {}),
    ...(args.taxNumber !== undefined ? { taxNumber: args.taxNumber } : {}),
  });
  const [view] = await customerViews(ctx.contactBook, ctx.companyId, [customer]);
  return Response.json(view ?? customerView(customer, null), { status: 201 });
});
