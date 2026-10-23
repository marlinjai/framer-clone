// src/app/api/books/products/[id]/route.ts
//
// GET    /api/books/products/<id>  -> ProductView
// PATCH  /api/books/products/<id>  -> ProductView
// DELETE /api/books/products/<id>  -> ProductView  (archives; never deletes)
//
// PATCH changes any of an item's fields (`kind`, `name`, `description`,
// `unitLabel`, `unitPrice`, `priceBasis`, `taxClass`, `discountBp`, with the
// rules of POST /api/books/products); `{ archived: false }` restores an
// archived item and `{ archived: true }` archives it (as DELETE does), each
// alone in its request (with other fields: 400), so a refused restore never
// leaves half a change behind. A name a live item already
// has answers 409 duplicate_product, also when restoring an item whose name was
// taken meanwhile. Drafts that copied the item keep their values: lines never
// reference an item. DELETE archives: the item leaves the search and its name
// is free again. Another company's id answers 404.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { booksRoute, readObject } from '@/server/books/http/route';
import {
  archiveProduct,
  getProduct,
  unarchiveProduct,
  updateProduct,
  type UpdateProductInput,
} from '@/server/books/repository/products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

const archivedBody = z.object({ archived: z.boolean().optional() }).passthrough();

export const GET = booksRoute<Params>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  return Response.json(await getProduct(ctx.scope, id));
});

export const PATCH = booksRoute<Params>('write', async (ctx, req, { params }) => {
  const { id } = await params;
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const parsed = archivedBody.safeParse(body.body);
  if (!parsed.success) {
    return jsonError('bad_body', 'invalid request body', 400, { issues: parsed.error.issues });
  }
  const { archived, ...fields } = parsed.data;
  if (archived !== undefined) {
    if (Object.keys(fields).length > 0) {
      return jsonError('bad_body', 'archived is sent alone: change the fields and the archive state in two requests', 400);
    }
    return Response.json(archived ? await archiveProduct(ctx.scope, id) : await unarchiveProduct(ctx.scope, id));
  }
  // The repository validates the fields (INVALID_INPUT names the offending ones).
  return Response.json(await updateProduct(ctx.scope, id, fields as UpdateProductInput));
});

export const DELETE = booksRoute<Params>('write', async (ctx, _req, { params }) => {
  const { id } = await params;
  return Response.json(await archiveProduct(ctx.scope, id));
});
