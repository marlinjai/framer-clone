// src/app/api/books/customers/[id]/contact-persons/[affiliationId]/route.ts
//
// DELETE /api/books/customers/<id>/contact-persons/<affiliationId> -> { items: ContactPersonView[] }
//
// The person stops being a contact person of this business: their affiliation ends (the row stays in the contacts
// database as history, with its role and dates) and is no longer offered. Drafts that point at the person keep the
// pointer and show it as unavailable; issuing them is refused until another person is chosen or the contact person
// is removed. Issued invoices are untouched (their snapshot is the record). Ending an ended one is a no-op.
// 422 `recipient_not_found` when the affiliation is not one of this customer's. Rights: `editBooks`.

import { booksRoute } from '@/server/books/http/route';
import { clearCustomerDefaultContactPerson, getCustomer } from '@/server/books/repository/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = booksRoute<{ id: string; affiliationId: string }>('write', async (ctx, _req, { params }) => {
  const { id, affiliationId } = await params;
  const customer = await getCustomer(ctx.scope, id);
  // The person comes from the affiliation itself (an ended one and an archived person included), so a retry after a
  // half-done leave still finds who left. A person who leaves is no longer the customer's default either, and only
  // while it still is them: a default chosen meanwhile stays.
  const leftId = await ctx.contactBook.endContactPerson(ctx.companyId, customer.contactId, affiliationId);
  await clearCustomerDefaultContactPerson(ctx.scope, id, leftId);
  const items = await ctx.contactBook.listContactPersons(ctx.companyId, customer.contactId);
  return Response.json({ items });
});
