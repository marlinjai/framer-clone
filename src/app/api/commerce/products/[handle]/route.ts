// src/app/api/commerce/products/[handle]/route.ts
//
// GET /api/commerce/products/[handle] -> ProductDTO | 404
//
// The b7 commerce catalog DETAIL read, resolved by `handle`, for an anonymous
// storefront. The tenant is the storefront HOST (CM-10): the host must resolve to
// a PUBLISHED site (else 403), that site's tenant group id must be valid (else
// 404 `commerce_not_provisioned`, fail closed, never a shared schema), and the
// read runs on the scoped Kysely handle `commerceTenantDb(tgId)`. Each variant's
// price comes from the b5 resolver (integer cents); the DTO is validated with
// zod. A handle that resolves to no LIVE product in THIS tenant group returns a
// real `not_found` 404 envelope, never an empty 200.
//
// handle is unique only among LIVE rows (a partial-unique index), so the lookup
// is a first-live-match (`handle = $1 AND deleted_at IS NULL`), see
// src/server/commerce/repository/storefront.ts.
//
// The read itself (query validation, the scoped Kysely read, DTO validation and
// the error envelopes) lives in src/server/commerce/readHandlers.ts, shared with
// the editor's authorized per-project route; THIS route only decides the tenant,
// from the request HOST and never from a session (D2 / D4).

import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { handleProductByHandle } from '@/server/commerce/readHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
): Promise<Response> {
  const { handle } = await params;
  return handleProductByHandle(req, handle, () =>
    resolveStorefrontCommerce(req.headers.get('host')),
  );
}
