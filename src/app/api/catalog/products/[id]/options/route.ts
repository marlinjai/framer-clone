// src/app/api/catalog/products/[id]/options/route.ts
//
// PUT /api/catalog/products/<id>/options { options: [{ id?, title, values: [{ id?, value }] }] } -> ProductDetail
//
// The options editor: the product's options become exactly these, and the
// variant matrix is regenerated (src/server/catalog/repository/variants.ts):
// ids keep their options, values and variants (a rename keeps price and
// stock), removed values take their variants with them, new combinations get
// new variants. At most three options (422), a service has none (422).

import { jsonError } from '@/lib/api/respond';
import type { OptionInput } from '@/lib/catalog/types';
import { catalogRoute, readObject } from '@/server/catalog/http/route';
import { setOptions } from '@/server/catalog/repository/variants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = catalogRoute<{ id: string }>('write', async (ctx, req, { params }) => {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  if (!Array.isArray(body.body.options)) return jsonError('invalid_input', 'send { options: [...] }', 422);
  return Response.json(await setOptions(ctx.scope, (await params).id, body.body.options as OptionInput[]));
});
