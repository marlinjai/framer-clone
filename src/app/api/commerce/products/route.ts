// src/app/api/commerce/products/route.ts
//
// GET /api/commerce/products -> { products: ProductDTO[]; nextCursor?: string }
//
// The b7 commerce catalog LIST read for an anonymous storefront. The tenant is
// the storefront HOST (CM-10): the host must resolve to a PUBLISHED site (else
// 403), that site's tenant group id must be valid (else 404
// `commerce_not_provisioned`, fail closed, never a shared schema), and every
// read then runs on the scoped Kysely handle `commerceTenantDb(tgId)`, so only
// that tenant group's `tg_<id>` schema is reachable. The graph -> typed
// ProductDTO projection (with each variant's integer-cents price from the b5
// resolver) lives in src/server/commerce/repository/storefront.ts, and the
// response is validated with zod before it is returned.
//
// This is a parallel commerce read surface: the typed product/option/variant graph
// is NOT forced through the flat CMS Collection/Row shape.
//
// Errors surface, never swallowed: a read failure or a response that fails its own
// zod schema is returned as a real `commerce_read_failed` envelope, and a malformed
// `limit` is a `bad_request` 400, never a silent success.
//
// The read itself (query validation, the scoped Kysely read, DTO validation and
// the error envelopes) lives in src/server/commerce/readHandlers.ts, shared with
// the editor's authorized per-project route; THIS route only decides the tenant,
// from the request HOST and never from a session (D2 / D4).

import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { handleListProducts } from '@/server/commerce/readHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleListProducts(req, () => resolveStorefrontCommerce(req.headers.get('host')));
}
