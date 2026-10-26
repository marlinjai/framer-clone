import 'server-only';

// src/server/commerce/readHandlers.ts
//
// The three commerce READ handlers (product list, product by handle, advisory
// inventory), shared by the two route families that serve them:
//
//   - the anonymous STOREFRONT routes  /api/commerce/*                (tenant from
//     the request HOST, see storefrontTenant.ts; the session is never read, D2)
//   - the authorized EDITOR routes     /api/projects/<id>/commerce/*  (tenant from
//     the signed-in session's access to that project, see editorTenant.ts)
//
// Each handler takes a `resolve` callback that returns the scoped Kysely handle
// for the request (or a ready 401 / 403 / 404 response). The handler validates
// its own query parameters first, then resolves the tenant, then reads ONLY
// through that handle, so both families share one implementation of the reads,
// the DTO validation and the error envelopes, while the tenancy decision stays
// with the route family that owns it.
//
// Errors surface, never swallowed: bad query input is a `bad_request` 400, an
// unknown product or variant a `not_found` 404, and any read or resolution
// failure a `commerce_read_failed` 500 envelope whose message is GENERIC; the
// full error goes to the server log only (faults.ts), never to the client.

import type { Kysely } from 'kysely';

import { jsonError } from '@/lib/api/respond';
import { commerceServerFault } from './faults';
import {
  availabilityDTOSchema,
  DEFAULT_CURRENCY,
  productDTOSchema,
  productListResponseSchema,
  toAvailabilityDTO,
} from '@/lib/commerce/dto';
import type { CommerceDB } from './db';
import { commerceReadRepository, type CatalogueView } from './repository/read';
import { UnknownVariantError } from './repository/errors';
import { getStorefrontProductByHandle, listStorefrontProducts } from './repository/storefront';

/** The tenant decision of one request: the scoped handle, or the response to return. */
export type CommerceReadContext =
  | { ok: true; db: Kysely<CommerceDB>; view: CatalogueView }
  | { ok: false; response: Response };

export type CommerceReadResolver = () => Promise<CommerceReadContext>;

/** Variant and location ids are uuids; anything else is refused before a read. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function readCurrency(url: URL): string {
  return (url.searchParams.get('currency') ?? DEFAULT_CURRENCY).toUpperCase();
}

/** GET products: one cursor page of the typed product graph. */
export async function handleListProducts(
  req: Request,
  resolve: CommerceReadResolver,
): Promise<Response> {
  const url = new URL(req.url);
  const currency = readCurrency(url);
  const cursor = url.searchParams.get('cursor') ?? undefined;

  // Parse and bound the page size. A non-integer / out-of-range limit is a client
  // error surfaced as a 400, not silently clamped to a default.
  const limitParam = url.searchParams.get('limit');
  let limit = DEFAULT_PAGE_SIZE;
  if (limitParam != null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      return jsonError(
        'bad_request',
        `limit must be an integer in [1, ${MAX_PAGE_SIZE}], got ${limitParam}`,
        400,
      );
    }
    limit = parsed;
  }

  try {
    const context = await resolve();
    if (!context.ok) return context.response;

    const result = await listStorefrontProducts(context.db, context.view, { limit, cursor, currency });
    // Validate the outgoing shape: a response that does not satisfy the DTO schema
    // is a server bug, surfaced as a 500 rather than shipped malformed.
    return Response.json(productListResponseSchema.parse(result));
  } catch (err) {
    return commerceServerFault(
      'commerce_read_failed',
      'the catalog could not be read',
      'list products',
      err,
    );
  }
}

/** GET products/[handle]: the live product with this handle, or a 404. */
export async function handleProductByHandle(
  req: Request,
  handle: string,
  resolve: CommerceReadResolver,
): Promise<Response> {
  const currency = readCurrency(new URL(req.url));
  try {
    const context = await resolve();
    if (!context.ok) return context.response;

    const dto = await getStorefrontProductByHandle(context.db, context.view, handle, currency);
    if (!dto) {
      return jsonError('not_found', `no product with handle ${handle}`, 404);
    }
    return Response.json(productDTOSchema.parse(dto));
  } catch (err) {
    return commerceServerFault(
      'commerce_read_failed',
      'the catalog could not be read',
      'read product',
      err,
    );
  }
}

/**
 * GET inventory: the advisory available quantity of one variant, summed over every location
 * (`locationId` omitted, what the storefront cart and add to cart ask) or at one location.
 * `limited: false` says the quantity is no limit (stock not tracked, or back-orders allowed).
 */
export async function handleInventory(
  req: Request,
  resolve: CommerceReadResolver,
): Promise<Response> {
  const url = new URL(req.url);
  const variantId = url.searchParams.get('variantId');
  const locationId = url.searchParams.get('locationId') ?? undefined;
  if (!variantId || !UUID.test(variantId)) {
    return jsonError('bad_request', 'the variantId query param must be a variant id', 400);
  }
  if (locationId !== undefined && !UUID.test(locationId)) {
    return jsonError('bad_request', 'the locationId query param must be a location id', 400);
  }

  try {
    const context = await resolve();
    if (!context.ok) return context.response;

    const availability = await commerceReadRepository.getAvailability(context.db, context.view, variantId, locationId);
    const dto = toAvailabilityDTO(availability);
    return Response.json(availabilityDTOSchema.parse(dto));
  } catch (err) {
    if (err instanceof UnknownVariantError) {
      return jsonError('not_found', `no variant ${variantId}`, 404);
    }
    return commerceServerFault(
      'commerce_read_failed',
      'the catalog could not be read',
      'read availability',
      err,
    );
  }
}
