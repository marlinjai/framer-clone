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
//   2. it calls Track B's atomic createOrder (b6), which runs the WHOLE order
//      inside ONE real prisma.$transaction (NOT adapter.transaction, the
//      verified no-op) and reserves each line through b3's guarded conditional
//      decrement (the 3 stacked guards). The server computes the authoritative
//      integer-cents totals/tax; any client-sent total would be ignored.
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
// (a visitor is not logged in). So instead of an interim super-admin principal,
// the gate is the request HOST: it must resolve to a PUBLISHED site via the same
// public host -> site resolver the SSR render path uses (resolvePublishedSite).
// A host that does not resolve to a published site is not a valid storefront and
// is rejected (403), never served. The full D4 guest-customer DB model +
// per-tenant commerce schema is MT-18 (it needs prisma schema changes); commerce
// stays single-schema here, so createOrder + withTenant('commerce', ...) are
// unchanged — MT-14's job is ONLY to remove the super-principal and gate on a
// valid host.
//
// Errors surface, never swallowed: an unresolvable host is a 403, a
// guarded-reserve rejection becomes the typed 409 the visitor sees (per-line
// shortages), a misconfigured catalog (variant with no inventory item) is a loud
// 500, and a server fault is a 500 envelope, never a false 201.

import { z } from 'zod';
import type { Prisma } from '@prisma/client';

import { getPrismaClient } from '@/server/db';
import { withTenant } from '@/server/commerce';
import { createOrder, type Cart } from '@/server/commerce/order/createOrder';
import { resolvePublishedSite } from '@/server/sites/publicResolver';
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

/** A client line after the server has resolved its inventory identity. */
interface ResolvedLine {
  variantId: string;
  inventoryItemId: string;
  quantity: number;
}

/** A dependency-free request id (the order-level idempotency key, server-owned). */
function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `order_${globalThis.crypto.randomUUID()}`;
  }
  // Fallback for a runtime without crypto.randomUUID. Still server-owned; the
  // client never supplies or influences the idempotency key.
  return `order_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Resolve each client {variantId, quantity} to the inventory item the server
 * will reserve against. The SKU is the v1 bridge between the catalog variant and
 * the inventory ledger (there is no FK, by design). A variant we cannot resolve
 * (unknown, no SKU, or no inventory item) is a catalog/inventory misconfiguration
 * surfaced LOUDLY, never a silent zero-stock success.
 */
async function resolveLines(
  tx: Prisma.TransactionClient,
  lines: { variantId: string; quantity: number }[],
): Promise<ResolvedLine[]> {
  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    const variant = await tx.productVariant.findFirst({
      where: { id: line.variantId, deletedAt: null },
      select: { id: true, sku: true },
    });
    if (!variant) {
      throw new Error(`unknown variant ${line.variantId}`);
    }
    if (!variant.sku) {
      throw new Error(`variant ${line.variantId} has no sku; cannot resolve inventory`);
    }
    const item = await tx.inventoryItem.findFirst({
      where: { sku: variant.sku, deletedAt: null },
      select: { id: true },
    });
    if (!item) {
      throw new Error(
        `no inventory item for variant ${line.variantId} (sku ${variant.sku})`,
      );
    }
    resolved.push({
      variantId: line.variantId,
      inventoryItemId: item.id,
      quantity: line.quantity,
    });
  }
  return resolved;
}

export async function POST(req: Request): Promise<Response> {
  // The gate for this anonymous storefront write is the request HOST: it must
  // resolve to a PUBLISHED site (the same public resolver the SSR render path
  // uses). A host that does not resolve to a published site is not a valid
  // storefront — a real 403, never a silent pass.
  const site = await resolvePublishedSite(req.headers.get('host'));
  if (!site) {
    return jsonError('forbidden', 'not a published storefront', 403);
  }

  const parsed = await parseBody(req, orderBodySchema);
  if (!parsed.ok) return parsed.response;
  const { lines, idempotencyKey } = parsed.data;

  try {
    const prisma = getPrismaClient();

    // Server-side identity resolution: variant -> inventory item (the client
    // never sends stock identity). Read-only, in the commerce schema.
    const resolved = await withTenant(prisma, (tx) => resolveLines(tx, lines));

    // The server authors the cart: idempotency key, currency, tax region, and
    // the inventory identity. createOrder ignores any client total; here the
    // client never sends one at all.
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

    // b6 createOrder runs the whole order inside ONE real prisma.$transaction and
    // reserves each line through b3's guarded conditional decrement. This is the
    // checkout STOP: order-created, no payment.
    const result = await createOrder(prisma, cart);

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
    // returns only the id). currencyCode + total(cents) are server-computed.
    const order = await withTenant(prisma, (tx) =>
      tx.order.findUnique({
        where: { id: result.orderId },
        select: { total: true, currencyCode: true },
      }),
    );
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
      { orderId: result.orderId, totalCents: order.total, currency: order.currencyCode },
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
