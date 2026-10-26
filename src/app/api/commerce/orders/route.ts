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
//   2. it calls the atomic createOrder (b6, ported in CM-09), which runs
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
// shortages), a variant this storefront does not sell is a typed 422
// `unknown_variant`, a misconfigured catalog (variant with no SKU or inventory
// item) is a 500, and every 500 carries a GENERIC message while the full error
// is logged server-side (faults.ts): no internals ever reach an anonymous buyer.
// Never a false 201.

import { z } from 'zod';

import { createOrder, type Cart } from '@/server/commerce/order/createOrder';
import { buyerSchema } from '@/server/commerce/payment/buyer';
import { shopTaxProfile } from '@/server/commerce/payment/shopTax';
import { configuredStripeApi } from '@/server/commerce/payment/deps';
import { readAccount } from '@/server/commerce/payment/stripe/connect';
import {
  readOrderTotal,
  resolveOrderLines,
  UnknownVariantError,
} from '@/server/commerce/repository/storefront';
import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { commerceServerFault } from '@/server/commerce/faults';
import { jsonError, parseBody } from '@/lib/api/respond';
import { DEFAULT_CURRENCY } from '@/lib/commerce/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The server-authored order context. The client never sends these: currency and
// tax region are server constants for v1 (one storefront, one region), and the
// idempotency key is generated per request. E7/E8 thread real values here.
const ORDER_TAX_REGION = 'DE';

/** The generic, buyer-safe message every order 500 carries (details are logged). */
const ORDER_FAILED_MESSAGE = 'the order could not be placed, please try again later';

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
    // The buyer, when the checkout already has it; else it is given when paying
    // (POST /api/commerce/orders/<id>/pay). The receipt is made from it.
    buyer: buyerSchema.optional(),
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
    return commerceServerFault(
      'commerce_order_failed',
      ORDER_FAILED_MESSAGE,
      'resolve storefront for order',
      err,
    );
  }
  if (!commerce.ok) return commerce.response;
  const { db, tenantGroupId, companyId, site } = commerce;
  const view = { companyId, siteId: site.siteId };

  const parsed = await parseBody(req, orderBodySchema);
  if (!parsed.ok) return parsed.response;
  const { lines, idempotencyKey, buyer } = parsed.data;

  try {
    // Server-side identity resolution: variant -> inventory item (the client
    // never sends stock identity). Read-only, in THIS tenant group's schema.
    let resolved: Awaited<ReturnType<typeof resolveOrderLines>>;
    try {
      resolved = await resolveOrderLines(db, view, lines);
    } catch (err) {
      if (err instanceof UnknownVariantError) {
        // The cart names an item this storefront does not sell (a stale cart, or
        // another shop's id). The CLIENT's problem, so a typed 422, NOT a 500
        // and NOT a 409 (the checkout reads every 409 as a stock shortage). The
        // id echoed is the client's own input, nothing server-side.
        return jsonError('unknown_variant', 'an item in the cart is not available', 422, {
          variantId: err.variantId,
        });
      }
      throw err;
    }

    // The server authors the cart: idempotency key, currency, tax region, and
    // the inventory identity. createOrder ignores any client total; here
    // the client never sends one at all.
    // One price basis per order: every product's prices include VAT, or none do.
    const bases = new Set(resolved.map((line) => line.priceBasis));
    if (bases.size > 1) {
      return jsonError(
        'mixed_price_basis',
        'some items are priced with VAT and some without; the shop owner has to align them before they can be bought together',
        422,
      );
    }
    // The company's tax status (its Books settings) decides whether VAT is charged at all, so the receipt the
    // Books issue for the order adds up to what was paid.
    const tax = await shopTaxProfile(db, companyId);
    // Stripe once it is configured and the company's account can take payments; the demo provider otherwise.
    const provider =
      configuredStripeApi() && (await readAccount(db, companyId)).status === 'ready' ? ('stripe' as const) : ('demo' as const);

    const cart: Cart = {
      // The client-owned idempotency key when present (so a re-submit dedupes to
      // the same order), else a fresh server-owned key.
      requestId: idempotencyKey ?? newRequestId(),
      tenantId: companyId,
      siteId: site.siteId,
      currency: DEFAULT_CURRENCY,
      taxRegion: ORDER_TAX_REGION,
      netOrGross: bases.has('net') ? 'net' : 'gross',
      kleinunternehmer: tax.kleinunternehmer,
      lines: resolved.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        variantId: line.variantId,
        quantity: line.quantity,
        // The variant is the line's reference (a late payment re-reserves it, the receipt line points at it).
        variantRef: line.variantId,
        variantRefSource: 'owned' as const,
      })),
      // The payment, pending for the payment window (021_order_payment).
      payment: { provider, buyer: buyer ?? null },
    };

    // b6 createOrder runs the whole order inside ONE READ COMMITTED
    // transaction on the scoped handle and reserves each line through b3's
    // guarded conditional decrement. This is the checkout STOP: order-created,
    // no payment.
    const result = await createOrder(db, tenantGroupId, cart);

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
      // loudly (logged in full) rather than returned as a false success.
      return commerceServerFault(
        'commerce_order_failed',
        ORDER_FAILED_MESSAGE,
        'read back order total',
        new Error(`order ${result.orderId} not found after create`),
      );
    }

    return Response.json(
      { orderId: result.orderId, totalCents: order.totalCents, currency: order.currency, provider },
      { status: 201 },
    );
  } catch (err) {
    // A real server fault (including a known variant with no SKU / inventory
    // item, a catalog misconfiguration). The full error goes to the server log;
    // the anonymous buyer gets a generic message, never internals.
    return commerceServerFault('commerce_order_failed', ORDER_FAILED_MESSAGE, 'create order', err);
  }
}
