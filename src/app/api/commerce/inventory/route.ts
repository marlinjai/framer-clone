// src/app/api/commerce/inventory/route.ts
//
// GET /api/commerce/inventory?variantId=[&locationId=] -> AvailabilityDTO (advisory)
//
// The commerce inventory availability read for an anonymous storefront. The
// tenant is the storefront HOST (CM-10): the host must resolve to a PUBLISHED
// site (else 403), that site's tenant group id must be valid (else 404
// `commerce_not_provisioned`, fail closed, never a shared schema), and the read
// runs on the scoped Kysely handle `commerceTenantDb(tgId)`, limited to the
// site's company. It sums the GENERATED column `inventory_level.available_quantity`
// (= stocked_quantity - reserved_quantity) of the variant's inventory item (linked
// by SKU) over every location, or reads one location when `locationId` is given.
// `limited: false` says the quantity is no limit: the variant's stock is not
// tracked (a service) or it may be back-ordered, the same policy the reserve applies.
//
// ADVISORY-ONLY (cross-check doc section 4.4; b7 spec): the returned
// `availableQuantity` is fire-and-forget freshness. It is NOT a reservation and NOT
// permission to complete a sale: it can be stale the instant it is read. The b3
// guarded conditional reserve is the SOLE authority on whether stock can be taken
// and rejects at reserve time against the live, write-locked row regardless of any
// number returned here. The `advisoryOnly: true` literal in the payload makes that
// contract explicit so no client path can treat this read as a sale guarantee.
//
// Errors surface, never swallowed: a missing or malformed id is a `bad_request` 400,
// a variant this company does not have a `not_found` 404, and a read failure a 500
// envelope.
//
// The read itself (query validation, the scoped read, DTO validation and the error
// envelopes) lives in src/server/commerce/readHandlers.ts, shared with the editor's
// authorized per-project route; THIS route only decides the tenant, from the
// request HOST and never from a session (D2 / D4).

import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { handleInventory } from '@/server/commerce/readHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleInventory(req, () => resolveStorefrontCommerce(req.headers.get('host')));
}
