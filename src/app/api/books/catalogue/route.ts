// src/app/api/books/catalogue/route.ts
//
// GET /api/books/catalogue[?q=...]  -> { items: CatalogueItemView[] }
//
// The active company's catalogue as the invoice line picker offers it
// (catalogue design, "The Books' own list is replaced";
// src/server/books/repository/catalogue.ts): each sellable variant of a product
// or service that is neither archived nor deleted, draft or published, with a
// base price in EUR, and what a line copies from it. `q` (at most 100
// characters) matches the product's folded search text, its title or the
// variant's title, every word of it; at most 50 items, by product title. A
// picked line stores the variant id as its only reference and keeps the copied
// values (POST /api/books/documents/<id>/lines). Reading needs viewBooks; the
// catalogue itself is edited in the Catalog area (/projects/catalog). Guard
// chain and status codes: src/server/books/http/route.ts and errorResponse.ts.

import { jsonError } from '@/lib/api/respond';
import { booksRoute } from '@/server/books/http/route';
import { MAX_SEARCH_LENGTH, searchCatalogue } from '@/server/books/repository/catalogue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute('read', async (ctx, req) => {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  if (q.length > MAX_SEARCH_LENGTH) {
    return jsonError('bad_query', `the search is longer than ${MAX_SEARCH_LENGTH} characters`, 400);
  }
  return Response.json({ items: await searchCatalogue(ctx.scope, q) });
});
