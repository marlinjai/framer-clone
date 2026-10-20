// src/app/api/books/contacts/route.ts
//
// GET /api/books/contacts?search=<text>  -> { items: ContactLabel[] }
//
// The contact picker of the customer form: the active company's contacts in the
// shared contacts database matching the search (name, company or role, email),
// archived ones left out, at most 25. Each item says whether a customer of this
// company already exists for it (`customerId`), so the form offers the existing
// customer instead of a duplicate. 503 `recipient_unavailable` when the
// contacts database cannot be read (or CONTACTS_DATABASE_URL is not set).

import { booksRoute } from '@/server/books/http/route';
import { contactLabel } from '@/server/books/http/views';
import { customersByContactIds } from '@/server/books/repository/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute('read', async (ctx, req) => {
  const search = (new URL(req.url).searchParams.get('search') ?? '').slice(0, 100);
  const contacts = await ctx.contactBook.search(ctx.companyId, { search, limit: 25 });

  // Which of them are customers already (archived customers included, so an
  // archived one is not silently duplicated): one lookup by the returned ids.
  const existing = await customersByContactIds(
    ctx.scope,
    contacts.map((c) => c.id),
  );
  const byContact = new Map(existing.map((c) => [c.contactId, c.id]));

  return Response.json({
    items: contacts.map((c) => ({ ...contactLabel(c), customerId: byContact.get(c.id) ?? null })),
  });
});
