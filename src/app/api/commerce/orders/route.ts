// src/app/api/commerce/orders/route.ts
//
// POST /api/commerce/orders -> 201 { orderId, totalCents, currency }
//                           -> 409 { ok: false, shortages: { variantId, needed, available }[] }
//
// The ONE storefront-side WRITE seam into the server-authoritative commerce
// engine. The client posts INTENTIONS ONLY: a list of { variantId, quantity }
// lines, with NO price and NO stock fields (the strict zod body below REJECTS
// any extra key, so a client-sent price/stock is a 400, never silently
// trusted). The server is the SOLE author of money + stock:
//   1. it resolves each variant to its inventory item (the SKU bridge: a
//      variant and its inventory item share a SKU; there is no FK between them
//      in v1, so the route bridges them here, server-side),
//   2. it calls the atomic createOrderKysely (b6, ported in CM-09), which runs
//      the WHOLE order inside ONE real READ COMMITTED transaction on the scoped
//      tenant handle (NOT adapter.transaction, the verified no-op) and reserves
//      each line through b3's guarded conditional decrement (the 3 stacked
//      guards). The server computes the authoritative integer-cents totals/tax;
//      any client-sent total would be ignored.
//
// checkout STOPS at order-created on the SERVER: there is NO payment provider, NO
// Stripe, and NO redirect to pay anywhere in this route. The storefront's
// fake-pay demo step runs CLIENT-side after this seam (it never calls this
// route), and a real provider would plug in behind its own payment route, not
// here. A successful order is the end of THIS seam.
//
// IDEMPOTENCY: the client MAY send its own `idempotencyKey` (one per checkout
// attempt). It becomes the order's request_id, so a double-submit or a
// back-then-resubmit of the SAME cart returns the SAME order (createOrder is
// idempotent on request_id) instead of creating a duplicate. When omitted, the
// server generates a fresh per-request key (the prior behavior).
//
// This is an ANONYMOUS storefront write: the published storefront has no session
// (a visitor is not logged in). So the gate AND the tenant are the request HOST
// (decision D4, multi-tenancy phase 2 plan): it must resolve to a PUBLISHED site
// via the same public host -> site resolver the SSR render path uses
// (resolvePublishedSite). A host that does not resolve to a published site is
// not a valid storefront and is rejected (403), never served. The resolved
// site's tenant group id then selects the commerce schema (CM-10): every read
// and the order write run on the scoped Kysely handle
// `commerceTenantDb(resolveTenantGroupForSite(site))`, so an order placed on
// host A can only ever land in tg_A. A session cookie is never consulted (D2).
// A published site with NO valid tenant group id fails CLOSED with a 404
// `commerce_not_provisioned` (never a shared-schema fallback, and deliberately
// not a 409, which the checkout client reads as a stock shortage).
//
// Errors surface, never swallowed: an unresolvable host is a 403, a published
// site without a valid tenant group is a 404 `commerce_not_provisioned`, a
// guarded-reserve rejection becomes the typed 409 the visitor sees (per-line
// shortages), a misconfigured catalog (variant with no inventory item) is a loud
// 500, and a server fault is a 500 envelope, never a false 201.

import { z } from 'zod';

import { createOrderKysely, type Cart } from '@/server/commerce/order/createOrder';
import {
  readOrderTotal,
  resolveOrderLines,
} from '@/server/commerce/repository/storefront';
import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { jsonError, parseBody } from '@/lib/api/respond';
import { DEFAULT_CURRENCY } from '@/lib/commerce/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The server-authored order context. The client never sends these: currency and
// tax region are server constants for v1 (one storefront, one region), and the
// idempotency key is generated per request. E7/E8 thread real values here.
const ORDER_TAX_REGION = 'DE';

// Intentions ONLY. `.strict()` makes an unknown key (a client-sent price, stock,
// or total) a 400 bad_body, so the server stays the sole author of money + stock.
const orderLineSchema = z
  .object({
    variantId: z.string().min(1),
    quantity: z.number().int().positive(),
  })
  .strict();

const orderBodySchema = z
  .object({
    lines: z.array(orderLineSchema).min(1),
    // Optional client-owned idempotency key for one checkout attempt. Bounded so
    // a malformed/oversized value is a 400, never trusted as a request_id. Stays
    // `.strict()`-compatible: a price/stock/total key is still rejected.
    idempotencyKey: z.string().min(8).max(200).optional(),
  })
  .strict();

/** A dependency-free request id (the order-level idempotency key, server-owned). */
function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `order_${globalThis.crypto.randomUUID()}`;
  }
  // Fallback for a runtime without crypto.randomUUID. Still server-owned; the
  // client never supplies or influences the idempotency key.
  return `order_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function POST(req: Request): Promise<Response> {
  // The gate AND the tenant for this anonymous storefront write are the request
  // HOST (D4): it must resolve to a PUBLISHED site (403 otherwise) whose tenant
  // group id is valid (404 commerce_not_provisioned otherwise, fail closed).
  let commerce: Awaited<ReturnType<typeof resolveStorefrontCommerce>>;
  try {
    commerce = await resolveStorefrontCommerce(req.headers.get('host'));
  } catch (err) {
    return jsonError(
      'commerce_order_failed',
      err instanceof Error ? err.message : 'failed to resolve the storefront',
      500,
    );
  }
  if (!commerce.ok) return commerce.response;
  const { db, tenantGroupId } = commerce;

  const parsed = await parseBody(req, orderBodySchema);
  if (!parsed.ok) return parsed.response;
  const { lines, idempotencyKey } = parsed.data;

  try {
    // Server-side identity resolution: variant -> inventory item (the client
    // never sends stock identity). Read-only, in THIS tenant group's schema.
    const resolved = await resolveOrderLines(db, lines);

    // The server authors the cart: idempotency key, currency, tax region, and
    // the inventory identity. createOrderKysely ignores any client total; here
    // the client never sends one at all.
    const cart: Cart = {
      // The client-owned idempotency key when present (so a re-submit dedupes to
      // the same order), else a fresh server-owned key.
      requestId: idempotencyKey ?? newRequestId(),
      currency: DEFAULT_CURRENCY,
      taxRegion: ORDER_TAX_REGION,
      lines: resolved.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        variantId: line.variantId,
        quantity: line.quantity,
      })),
    };

    // b6 createOrderKysely runs the whole order inside ONE READ COMMITTED
    // transaction on the scoped handle and reserves each line through b3's
    // guarded conditional decrement. This is the checkout STOP: order-created,
    // no payment.
    const result = await createOrderKysely(db, tenantGroupId, cart);

    if (!result.ok) {
      // A guarded-reserve rejection. Map the inventory-item-keyed shortages back
      // to the client's variant vocabulary so the visitor sees WHICH lines failed.
      const variantByItem = new Map(
        resolved.map((line) => [line.inventoryItemId, line.variantId]),
      );
      const shortages = result.shortages.map((shortage) => ({
        variantId: variantByItem.get(shortage.inventoryItemId) ?? shortage.inventoryItemId,
        needed: shortage.needed,
        available: shortage.available,
      }));
      return Response.json({ ok: false, shortages }, { status: 409 });
    }

    // Read the server-authoritative total back from the committed order (b6
    // returns only the id). currency + total (cents) are server-computed.
    const order = await readOrderTotal(db, result.orderId);
    if (!order) {
      // The order committed but vanished on read back: a server fault, surfaced
      // loudly rather than returned as a false success.
      return jsonError(
        'commerce_order_failed',
        `order ${result.orderId} not found after create`,
        500,
      );
    }

    return Response.json(
      { orderId: result.orderId, totalCents: order.totalCents, currency: order.currency },
      { status: 201 },
    );
  } catch (err) {
    return jsonError(
      'commerce_order_failed',
      err instanceof Error ? err.message : 'failed to create order',
      500,
    );
  }
}
