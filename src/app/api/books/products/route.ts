// src/app/api/books/products/route.ts
//
// GET  /api/books/products[?q=...&includeArchived=1&cursor=...]  -> { items, nextCursor, total }
// POST /api/books/products                                        -> 201 ProductView
//
// The active company's product and service list (invoice editor plan, phase
// 4). GET pages the items live first, then by name (100 a page); `q` (at most
// 100 characters) matches name and description, case and accents ignored, every
// word of it must occur. Archived items are listed only with
// `includeArchived=1`. POST adds an item: `name` and `unitPrice` (integer cents,
// never negative) are required; `kind` ('service' or 'product', default
// service), `description`, `unitLabel` (default 'Stk'), `priceBasis` ('net' or
// 'gross', default net), `taxClass` ('standard', 'reduced' or 'zero', default
// standard) and `discountBp` (basis points, default 0) are optional. A name a
// live item already has (case and accents ignored) answers 409
// duplicate_product. Draft lines copy an item's values when it is picked and
// never reference it. Guard chain and status codes:
// src/server/books/http/route.ts and errorResponse.ts.

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import { MAX_SEARCH_LENGTH, createProduct, listProducts } from '@/server/books/repository/products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute('read', async (ctx, req) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  if (q.length > MAX_SEARCH_LENGTH) {
    return jsonError('bad_query', `the search is longer than ${MAX_SEARCH_LENGTH} characters`, 400);
  }
  const page = await listProducts(ctx.scope, {
    q,
    includeArchived: url.searchParams.get('includeArchived') === '1',
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: 100,
  });
  return Response.json(page);
});

export const POST = booksRoute('write', async (ctx, req) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  // The repository validates every field (INVALID_INPUT names the offending ones).
  const product = await createProduct(ctx.scope, body.body as Parameters<typeof createProduct>[1]);
  return Response.json(product, { status: 201 });
});
