// src/app/api/commerce/orders/__tests__/route.itest.ts
//
// Integration test (Dockerized Postgres) for the storefront order-create WRITE
// seam, POST /api/commerce/orders, after CM-10 moved it onto the per-tenant-group
// schema. It runs on the SHARED integration database (vitest.integration.setup.ts),
// provisions its OWN tenant group `tg_<id>`, seeds a priced + stocked variant into
// it, publishes a site stamped with that tenant group, and drives the REAL route
// handler with that site's Host header, proving:
//
//   1. the server computes the order total AUTHORITATIVELY (integer cents,
//      net + tax), returning 201 { orderId, totalCents, currency }, and the order
//      lands in THIS tenant group's schema,
//   2. the request body is INTENTIONS ONLY: a client-sent price/stock/total field
//      is rejected (400, `.strict()`), so the server stays the sole author of
//      money + stock,
//   3. a simulated oversell returns typed per-line shortages keyed by VARIANT id
//      (409 { ok:false, shortages }) and the whole order rolls back,
//   4. a host that does not resolve to a published site is a 403 (D4),
//   5. the route carries the host gate and NO payment/Stripe code (checkout
//      STOPS at order-created) and no session/withTenant seam,
//   6. an abandoned hold ends at its window: an expired payment is closed before
//      the next order reserves, so it can never read as a shortage, while a hold
//      still inside its window keeps its stock.
//
// Cross-tenant isolation is proven separately in
// src/app/api/commerce/__tests__/routes.isolation.itest.ts.
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  countInSchema,
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { POST } from '../route';

let fx: StorefrontFixtures;
let tenant: ProvisionedTenant;
let host = '';

beforeAll(async () => {
  fx = openStorefrontFixtures();
  tenant = await provisionCommerceTenant(fx, 'cm10-orders');
  ({ host } = await createPublishedSite(fx, tenant.tgId, 'cm10-orders'));
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

async function seedBuyableVariant(amountCents: number, stocked: number) {
  return seedBuyableProduct(tenant.db, {
    title: `P-${randomUUID().slice(0, 6)}`,
    handle: `p-${randomUUID()}`,
    amountCents,
    stocked,
  });
}

function postOrder(body: unknown, requestHost = host): Promise<Response> {
  return POST(
    new Request(`http://${requestHost}/api/commerce/orders`, {
      method: 'POST',
      // The Host header is what the route reads (req.headers.get('host')) to
      // resolve the storefront tenant (D4). undici permits setting it here.
      headers: { 'content-type': 'application/json', host: requestHost },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/commerce/orders on the tenant schema (Dockerized Postgres)', () => {
  it('computes the total server-side and returns 201 { orderId, totalCents, currency }', async () => {
    const { variantId } = await seedBuyableVariant(1000, 10);

    const res = await postOrder({ lines: [{ variantId, quantity: 2 }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { orderId: string; totalCents: number; currency: string };

    // net 2000 + 19% standard VAT (380) = 2380, computed by the server (the
    // client never sent a price or a total).
    expect(body.totalCents).toBe(2380);
    expect(body.currency).toBe('EUR');
    expect(typeof body.orderId).toBe('string');

    // The order persisted IN THIS TENANT'S SCHEMA with the same total.
    const order = await tenant.db
      .selectFrom('order')
      .select(['total', 'subtotal', 'tax_amount'])
      .where('id', '=', body.orderId)
      .executeTakeFirstOrThrow();
    expect(order.total).toBe(2380);
    expect(order.subtotal).toBe(2000);
    expect(order.tax_amount).toBe(380);
  });

  it('rejects a body carrying a client price/stock/total field (intentions only)', async () => {
    const { variantId } = await seedBuyableVariant(1000, 10);

    const ordersBefore = await countInSchema(fx, tenant.schema, 'order');
    for (const body of [
      { lines: [{ variantId, quantity: 1, priceCents: 1 }] },
      { lines: [{ variantId, quantity: 1, stock: 999 }] },
      { lines: [{ variantId, quantity: 1 }], total: 1 },
    ]) {
      const res = await postOrder(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_body');
    }
    // No order was created from the rejected requests.
    expect(await countInSchema(fx, tenant.schema, 'order')).toBe(ordersBefore);
  });

  it('returns 409 typed per-line shortages (keyed by variantId) on an oversell', async () => {
    const seeded = await seedBuyableVariant(1000, 1); // only 1 in stock

    const ordersBefore = await countInSchema(fx, tenant.schema, 'order');
    const res = await postOrder({ lines: [{ variantId: seeded.variantId, quantity: 5 }] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: false;
      shortages: { variantId: string; needed: number; available: number }[];
    };
    expect(body.ok).toBe(false);
    expect(body.shortages).toEqual([{ variantId: seeded.variantId, needed: 5, available: 1 }]);

    // The whole order rolled back: no new order, the stock is untouched.
    expect(await countInSchema(fx, tenant.schema, 'order')).toBe(ordersBefore);
    const level = await tenant.db
      .selectFrom('inventory_level')
      .select('reserved_quantity')
      .where('inventory_item_id', '=', seeded.inventoryItemId)
      .executeTakeFirstOrThrow();
    expect(level.reserved_quantity).toBe(0);
  });

  it('returns 403 for a host that does not resolve to a published site', async () => {
    const { variantId } = await seedBuyableVariant(1000, 10);
    const ordersBefore = await countInSchema(fx, tenant.schema, 'order');
    const res = await postOrder(
      { lines: [{ variantId, quantity: 1 }] },
      'not-a-store.example.com',
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(await countInSchema(fx, tenant.schema, 'order')).toBe(ordersBefore);
  });
});

describe('an abandoned hold on the last unit', () => {
  const lastUnit = () => seedBuyableVariant(1000, 1);

  async function place(variantId: string, idempotencyKey?: string) {
    const res = await postOrder({ lines: [{ variantId, quantity: 1 }], idempotencyKey });
    return { status: res.status, body: (await res.json()) as { orderId: string } };
  }

  /** The buyer's window ran out while nobody touched the order (the clock moved, nothing else). */
  async function letWindowRunOut(orderId: string) {
    await tenant.db
      .updateTable('order_payment')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('order_id', '=', orderId)
      .execute();
  }

  async function reserved(inventoryItemId: string) {
    const level = await tenant.db
      .selectFrom('inventory_level')
      .select('reserved_quantity')
      .where('inventory_item_id', '=', inventoryItemId)
      .executeTakeFirstOrThrow();
    return level.reserved_quantity;
  }

  async function paymentStatus(orderId: string) {
    const row = await tenant.db
      .selectFrom('order_payment')
      .select('status')
      .where('order_id', '=', orderId)
      .executeTakeFirstOrThrow();
    return row.status;
  }

  it('forward: the next buyer gets the unit, never a 409 for a hold that ran out', async () => {
    const seeded = await lastUnit();
    const abandoned = await place(seeded.variantId);
    expect(abandoned.status).toBe(201);
    await letWindowRunOut(abandoned.body.orderId);

    const next = await place(seeded.variantId);
    expect(next.status).toBe(201);
    expect(next.body.orderId).not.toBe(abandoned.body.orderId);
    expect(await paymentStatus(abandoned.body.orderId)).toBe('expired');
    expect(await paymentStatus(next.body.orderId)).toBe('pending');
    // One hold: the new order's, the old one was given back exactly once.
    expect(await reserved(seeded.inventoryItemId)).toBe(1);
    const events = await tenant.db
      .selectFrom('payment_event')
      .select(['event_id', 'event_type'])
      .where('order_id', '=', abandoned.body.orderId)
      .execute();
    expect(events).toEqual([{ event_id: `expiry:${abandoned.body.orderId}`, event_type: 'checkout_expired' }]);
  });

  it('a hold still inside its window keeps its stock: the next buyer is told the truth', async () => {
    const seeded = await lastUnit();
    const holding = await place(seeded.variantId);
    expect(holding.status).toBe(201);

    expect((await place(seeded.variantId)).status).toBe(409);
    expect(await paymentStatus(holding.body.orderId)).toBe('pending');
    expect(await reserved(seeded.inventoryItemId)).toBe(1);
  });

  it('re-entry: the same attempt sent again answers its closed order, and takes no stock with it', async () => {
    const seeded = await lastUnit();
    const key = `attempt-${randomUUID()}`;
    const first = await place(seeded.variantId, key);
    await letWindowRunOut(first.body.orderId);

    // The checkout's idempotency key: the same order comes back, closed (paying it answers payment_closed and
    // the checkout starts over with a new key), and the unit it gave up stays free.
    const again = await place(seeded.variantId, key);
    expect(again.status).toBe(201);
    expect(again.body.orderId).toBe(first.body.orderId);
    expect(await paymentStatus(first.body.orderId)).toBe('expired');
    expect(await reserved(seeded.inventoryItemId)).toBe(0);

    expect((await place(seeded.variantId, `attempt-${randomUUID()}`)).status).toBe(201);
    expect(await reserved(seeded.inventoryItemId)).toBe(1);
  });
});

describe('source contract', () => {
  it('gates on the request host -> published site and STOPS at order-created (no charge)', () => {
    const src = readFileSync(path.resolve(__dirname, '../route.ts'), 'utf8');
    const edge = readFileSync(
      path.resolve(__dirname, '../../../../../server/commerce/storefrontTenant.ts'),
      'utf8',
    );
    // The anonymous-storefront write gates on (and takes its tenant from) the
    // HOST resolving to a published site (the D4 contract), via the shared
    // storefront edge, NOT an interim super-admin secret or a session.
    expect(src).toMatch(/resolveStorefrontCommerce\(req\.headers\.get\('host'\)\)/);
    expect(edge).toMatch(/from\s+['"]@\/server\/sites\/publicResolver['"]/);
    expect(edge).toMatch(/resolvePublishedSite\(/);
    // The removed seams must be gone.
    expect(src).not.toMatch(/from\s+['"]@\/server\/auth\/guard['"]/);
    expect(src).not.toMatch(/withTenant|getPrismaClient|cookies\(/);
    // Placing STOPS at order-created: the order's payment is only opened (pending); charging happens in the
    // pay route (demo) or on Stripe's page, never here. The route may read which provider the company uses.
    expect(src).toMatch(/STOPS at order-created/);
    expect(src).not.toMatch(/from\s+['"]stripe['"]|@stripe\//i);
    expect(src).not.toMatch(/redirectToCheckout|payment_intent|createPaymentIntent|createCheckoutSession|\.start\(/i);
  });
});
