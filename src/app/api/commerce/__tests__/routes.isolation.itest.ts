// src/app/api/commerce/__tests__/routes.isolation.itest.ts
//
// CM-10: the ROUTE-LEVEL two-tenant isolation proof. Where the repository
// isolation suites (read/catalog/pricing/reserve/createOrder *.isolation.itest.ts)
// call the Kysely repos with a hand-built handle, this suite drives the ACTUAL
// storefront route handlers with two different Host headers and lets the routes
// do the whole resolution themselves, exactly as in production:
//
//   Host -> resolvePublishedSite (Prisma, public) -> resolveTenantGroupForSite
//        -> commerceTenantDb(tgId) as the low-privilege `commerce_app` role
//        -> tg_<id>.<table>
//
// Setup (shared integration database, see storefrontFixtures.ts): two freshly
// provisioned tenant groups TG_A and TG_B, each with its OWN product, variant,
// price and stock; one published site per tenant group (host A, host B); a
// pre-existing order in TG_B placed through host B; a DECOY product planted in
// the legacy shared `commerce` schema (the pre-CM-10 target), which no route may
// ever fall back to; and a third published site whose tenant group id is a
// legacy non-UUID sentinel (fail-closed probe).
//
// Assertions:
//   - list: host A sees exactly A's product, never B's or the decoy; symmetric.
//   - detail: B's handle on host A is a 404 (and vice versa); the decoy's handle
//     is a 404 on both.
//   - inventory: B's (item, location) pair on host A is a 404 (and vice versa).
//   - orders: an order posted on host A lands ONLY in tg_A (tg_B's order and
//     reservation counts do not move); B's variant id posted on host A cannot be
//     resolved (A's schema cannot see it): a 422 unknown_variant that writes
//     nothing anywhere; reusing
//     B's idempotency key on host A creates A's OWN order, never returns B's.
//   - fail closed: the unprovisioned site answers 404 commerce_not_provisioned
//     on all four routes and writes nothing.
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate; it
// runs only under `pnpm test:integration` against Docker.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  countInSchema,
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type SeededProduct,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { GET as productsGET } from '../products/route';
import { GET as productGET } from '../products/[handle]/route';
import { GET as inventoryGET } from '../inventory/route';
import { POST as ordersPOST } from '../orders/route';

let fx: StorefrontFixtures;
let tgA: ProvisionedTenant;
let tgB: ProvisionedTenant;
let hostA = '';
let hostB = '';
let hostUnprovisioned = '';
let hostNoSchema = '';
let productA: SeededProduct;
let productB: SeededProduct;
let orderBId = '';
const ORDER_B_KEY = `cm10-iso-order-b-${randomUUID()}`;
const DECOY_HANDLE = `decoy-shared-${randomUUID().slice(0, 8)}`;

function get(path: string, host: string): Request {
  return new Request(`http://t${path}`, { headers: { host } });
}

function post(body: unknown, host: string): Promise<Response> {
  return ordersPOST(
    new Request('http://t/api/commerce/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host },
      body: JSON.stringify(body),
    }),
  );
}

async function listHandles(host: string): Promise<string[]> {
  const res = await productsGET(get('/api/commerce/products?limit=100', host));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { products: Array<{ handle: string }> };
  return body.products.map((p) => p.handle);
}

async function countOrdersAndReservations(t: ProvisionedTenant) {
  return {
    orders: await countInSchema(fx, t.schema, 'order'),
    reservations: await countInSchema(fx, t.schema, 'reservation'),
  };
}

beforeAll(async () => {
  fx = openStorefrontFixtures();
  tgA = await provisionCommerceTenant(fx, 'cm10-iso-a');
  tgB = await provisionCommerceTenant(fx, 'cm10-iso-b');

  productA = await seedBuyableProduct(tgA.db, {
    title: 'WIDGET_A',
    handle: `widget-a-${randomUUID().slice(0, 8)}`,
    amountCents: 1000,
    stocked: 10,
  });
  productB = await seedBuyableProduct(tgB.db, {
    title: 'WIDGET_B',
    handle: `widget-b-${randomUUID().slice(0, 8)}`,
    amountCents: 2000,
    stocked: 10,
  });

  ({ host: hostA } = await createPublishedSite(fx, tgA.tgId, 'cm10-iso-a'));
  ({ host: hostB } = await createPublishedSite(fx, tgB.tgId, 'cm10-iso-b'));
  ({ host: hostUnprovisioned } = await createPublishedSite(fx, 'legacy-tenant-group', 'cm10-iso-x'));
  // A VALID tenant group UUID that was never provisioned: no tg_<id> schema.
  ({ host: hostNoSchema } = await createPublishedSite(fx, randomUUID(), 'cm10-iso-n'));

  // The DECOY: a live product in the legacy shared `commerce` schema, the
  // pre-CM-10 target every site used to read. No route may fall back to it.
  await fx.owner`
    -- tenant-db-guard-disable-next-line G3: deliberate DECOY fixture (the trap the isolation proof needs)
    INSERT INTO commerce.product (id, title, handle, updated_at)
    VALUES (${randomUUID()}, 'DECOY_SHARED', ${DECOY_HANDLE}, now())
  `;

  // A pre-existing order in TG_B, placed through host B.
  const res = await post(
    { lines: [{ variantId: productB.variantId, quantity: 1 }], idempotencyKey: ORDER_B_KEY },
    hostB,
  );
  expect(res.status).toBe(201);
  orderBId = ((await res.json()) as { orderId: string }).orderId;
}, 180_000);

afterAll(async () => {
  if (fx) {
    // tenant-db-guard-disable-next-line G3: deliberate DECOY fixture (the trap the isolation proof needs)
    await fx.owner`DELETE FROM commerce.product WHERE handle = ${DECOY_HANDLE}`;
    await fx.close();
  }
});

describe('route-level two-tenant isolation (host decides the tenant group)', () => {
  it('pre-existing state: order B lives in tg_B only', async () => {
    const inB = await tgB.db
      .selectFrom('order')
      .select('id')
      .where('id', '=', orderBId)
      .executeTakeFirst();
    const inA = await tgA.db
      .selectFrom('order')
      .select('id')
      .where('id', '=', orderBId)
      .executeTakeFirst();
    expect(inB?.id).toBe(orderBId);
    expect(inA).toBeUndefined();
  });

  it('list: each host sees exactly its own catalog, never the other tenant or the shared decoy', async () => {
    const a = await listHandles(hostA);
    const b = await listHandles(hostB);

    expect(a).toEqual([productA.handle]);
    expect(b).toEqual([productB.handle]);
    expect(a).not.toContain(DECOY_HANDLE);
    expect(b).not.toContain(DECOY_HANDLE);
  });

  it("detail: the other tenant's handle and the shared decoy are 404 on each host", async () => {
    const own = await productGET(get(`/api/commerce/products/${productA.handle}`, hostA), {
      params: Promise.resolve({ handle: productA.handle }),
    });
    expect(own.status).toBe(200);
    expect((await own.json()).title).toBe('WIDGET_A');

    const cases: Array<[string, string]> = [
      [hostA, productB.handle],
      [hostB, productA.handle],
      [hostA, DECOY_HANDLE],
      [hostB, DECOY_HANDLE],
    ];
    for (const [host, handle] of cases) {
      const res = await productGET(get(`/api/commerce/products/${handle}`, host), {
        params: Promise.resolve({ handle }),
      });
      expect(res.status, `${handle} on ${host}`).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
    }
  });

  it("inventory: the other tenant's variant is 404 on each host", async () => {
    const qs = (p: SeededProduct) => `/api/commerce/inventory?variantId=${p.variantId}&locationId=${p.locationId}`;

    const ownA = await inventoryGET(get(qs(productA), hostA));
    expect(ownA.status).toBe(200);
    expect((await ownA.json()).availableQuantity).toBe(10);

    const crossA = await inventoryGET(get(qs(productB), hostA));
    const crossB = await inventoryGET(get(qs(productA), hostB));
    expect(crossA.status).toBe(404);
    expect(crossB.status).toBe(404);
  });

  it('orders: an order placed on host A lands ONLY in tg_A', async () => {
    const beforeA = await countOrdersAndReservations(tgA);
    const beforeB = await countOrdersAndReservations(tgB);

    const res = await post({ lines: [{ variantId: productA.variantId, quantity: 2 }] }, hostA);
    expect(res.status).toBe(201);
    const { orderId, totalCents } = (await res.json()) as { orderId: string; totalCents: number };
    // 2 x 1000 net + 19% VAT, computed from tg_A's price (B's price is 2000).
    expect(totalCents).toBe(2380);

    expect(await countOrdersAndReservations(tgA)).toEqual({
      orders: beforeA.orders + 1,
      reservations: beforeA.reservations + 1,
    });
    expect(await countOrdersAndReservations(tgB)).toEqual(beforeB);

    const inA = await tgA.db.selectFrom('order').select('id').where('id', '=', orderId).executeTakeFirst();
    const inB = await tgB.db.selectFrom('order').select('id').where('id', '=', orderId).executeTakeFirst();
    expect(inA?.id).toBe(orderId);
    expect(inB).toBeUndefined();
  });

  it("orders: B's variant posted on host A is a 422 unknown_variant and writes nothing anywhere", async () => {
    const beforeA = await countOrdersAndReservations(tgA);
    const beforeB = await countOrdersAndReservations(tgB);
    const levelBBefore = await tgB.db
      .selectFrom('inventory_level')
      .select('reserved_quantity')
      .where('inventory_item_id', '=', productB.inventoryItemId)
      .executeTakeFirstOrThrow();

    const res = await post({ lines: [{ variantId: productB.variantId, quantity: 1 }] }, hostA);
    // A's schema cannot see B's variant: the typed client error, NOT a 500 and
    // NOT a 409 (the checkout reads 409 as a stock shortage).
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; variantId: string } };
    expect(body.error.code).toBe('unknown_variant');
    expect(body.error.variantId).toBe(productB.variantId);

    expect(await countOrdersAndReservations(tgA)).toEqual(beforeA);
    expect(await countOrdersAndReservations(tgB)).toEqual(beforeB);
    const levelBAfter = await tgB.db
      .selectFrom('inventory_level')
      .select('reserved_quantity')
      .where('inventory_item_id', '=', productB.inventoryItemId)
      .executeTakeFirstOrThrow();
    expect(levelBAfter.reserved_quantity).toBe(levelBBefore.reserved_quantity);
  });

  it("orders: reusing B's idempotency key on host A creates A's own order, never returns B's", async () => {
    const res = await post(
      { lines: [{ variantId: productA.variantId, quantity: 1 }], idempotencyKey: ORDER_B_KEY },
      hostA,
    );
    expect(res.status).toBe(201);
    const { orderId } = (await res.json()) as { orderId: string };
    expect(orderId).not.toBe(orderBId);
    const inA = await tgA.db
      .selectFrom('order')
      .select(['id', 'request_id'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
    expect(inA.request_id).toBe(ORDER_B_KEY);
  });
});

describe('FAIL CLOSED: a published site with no valid tenant group, or no schema', () => {
  it.each([
    ['a legacy non-UUID tenant group', () => hostUnprovisioned],
    ['a valid tenant group UUID whose schema was never created', () => hostNoSchema],
  ])('%s answers 404 commerce_not_provisioned on all four routes and writes nothing', async (_label, hostOf) => {
    const hostUnprovisioned = hostOf();
    const beforeA = await countOrdersAndReservations(tgA);
    const beforeB = await countOrdersAndReservations(tgB);

    const responses = [
      await productsGET(get('/api/commerce/products', hostUnprovisioned)),
      await productGET(get(`/api/commerce/products/${DECOY_HANDLE}`, hostUnprovisioned), {
        params: Promise.resolve({ handle: DECOY_HANDLE }),
      }),
      await inventoryGET(
        get(
          `/api/commerce/inventory?variantId=${productA.inventoryItemId}&locationId=${productA.locationId}`,
          hostUnprovisioned,
        ),
      ),
      await post({ lines: [{ variantId: productA.variantId, quantity: 1 }] }, hostUnprovisioned),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('commerce_not_provisioned');
    }

    expect(await countOrdersAndReservations(tgA)).toEqual(beforeA);
    expect(await countOrdersAndReservations(tgB)).toEqual(beforeB);
  });
});
