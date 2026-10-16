// src/app/api/commerce/inventory/route.ts
//
// GET /api/commerce/inventory?variantId=&locationId= -> AvailabilityDTO (advisory)
//
// The b7 commerce inventory availability read for an anonymous storefront. The
// tenant is the storefront HOST (CM-10): the host must resolve to a PUBLISHED
// site (else 403), that site's tenant group id must be valid (else 404
// `commerce_not_provisioned`, fail closed, never a shared schema), and the read
// runs on the scoped Kysely handle `commerceTenantDb(tgId)`. It reads the
// GENERATED column `inventory_level.available_quantity`
// (= stocked_quantity - reserved_quantity) for the (item, location) pair in THAT
// tenant group's schema and returns it as the advisory-only DTO.
//
// ADVISORY-ONLY (cross-check doc section 4.4; b7 spec): the returned
// `availableQuantity` is fire-and-forget freshness. It is NOT a reservation and NOT
// permission to complete a sale: it can be stale the instant it is read. The b3
// guarded conditional reserve is the SOLE authority on whether stock can be taken
// and rejects at reserve time against the live, write-locked row regardless of any
// number returned here. The `advisoryOnly: true` literal in the payload makes that
// contract explicit so no client path can treat this read as a sale guarantee.
//
// v1 item/variant identity: there is no separate variant -> inventory_item mapping
// table in this build, so the storefront's `variantId` IS the inventory_item_id at
// this boundary (a 1:1 identity for v1). E7/E8 may introduce a mapping; only this
// lookup key changes if so.
//
// Errors surface, never swallowed: a missing query param is a `bad_request` 400, an
// (item, location) pair with no level row is a `not_found` 404 (the pairing is
// genuinely unknown, never fabricated as 0), and a read failure is a 500 envelope.
//
// The read itself (query validation, the scoped Kysely read, DTO validation and
// the error envelopes) lives in src/server/commerce/readHandlers.ts, shared with
// the editor's authorized per-project route; THIS route only decides the tenant,
// from the request HOST and never from a session (D2 / D4).

import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { handleInventory } from '@/server/commerce/readHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleInventory(req, () => resolveStorefrontCommerce(req.headers.get('host')));
}
