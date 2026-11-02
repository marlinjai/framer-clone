// src/app/api/commerce/orders/[orderId]/pay/__tests__/route.itest.ts
//
// The storefront checkout through the real routes (place the order, then pay it with the demo provider),
// against a provisioned tenant schema, the tenant taken from the request host only:
//   - forward: 201 order, 200 paid; the receipt waits for the Books (this shop's company has none set up),
//     the payment stands;
//   - a declined card: 402, the order is closed and its stock released;
//   - paying twice, a closed order or one whose window ran out: 409 payment_closed; another shop's order: 404;
//   - no buyer: 422 buyer_required, nothing paid;
//   - an expired order that cannot be closed stops only itself, never another buyer of the shop;
//   - paying closes only its own expired order: every other one waits for its job, which the order route wrote.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { POST as placeOrder } from '../../../route';
import { POST as pay } from '../route';

let fx: StorefrontFixtures;
let tenant: ProvisionedTenant;
let host = '';
let otherHost = '';

beforeAll(async () => {
  fx = openStorefrontFixtures();
  tenant = await provisionCommerceTenant(fx, 'pay-route');
  ({ host } = await createPublishedSite(fx, tenant.tgId, 'pay-route'));
  const other = await provisionCommerceTenant(fx, 'pay-route-other');
  ({ host: otherHost } = await createPublishedSite(fx, other.tgId, 'pay-route-other'));
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

const BUYER = {
  name: 'Alex Example',
  email: 'alex@example.com',
  addressLine1: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  country: 'de',
};

function request(path: string, body: unknown, requestHost = host): Request {
  return new Request(`http://${requestHost}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: requestHost },
    body: JSON.stringify(body),
  });
}

async function order(stocked = 5, buyer?: unknown) {
  const seeded = await seedBuyableProduct(tenant.db, {
    title: `P-${randomUUID().slice(0, 6)}`,
    handle: `p-${randomUUID()}`,
    amountCents: 1000,
    stocked,
  });
  const res = await placeOrder(request('/api/commerce/orders', { lines: [{ variantId: seeded.variantId, quantity: 1 }], buyer }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { orderId: string; totalCents: number };
  return { ...seeded, orderId: body.orderId, totalCents: body.totalCents };
}

function payOrder(orderId: string, body: unknown, requestHost = host) {
  return pay(request(`/api/commerce/orders/${orderId}/pay`, body, requestHost), { params: Promise.resolve({ orderId }) });
}

async function letWindowRunOut(orderId: string) {
  await tenant.db
    .updateTable('order_payment')
    .set({ expires_at: new Date(Date.now() - 60_000) })
    .where('order_id', '=', orderId)
    .execute();
}

async function reserved(item: string) {
  const level = await tenant.db
    .selectFrom('inventory_level')
    .select('reserved_quantity')
    .where('inventory_item_id', '=', item)
    .executeTakeFirstOrThrow();
  return level.reserved_quantity;
}

describe('POST /api/commerce/orders/<id>/pay (demo provider)', () => {
  it('forward: the order is paid; the receipt waits for the Books, the payment stands', async () => {
    const placed = await order();
    const payment = await tenant.db
      .selectFrom('order_payment')
      .select(['status', 'amount', 'application_fee_amount'])
      .where('order_id', '=', placed.orderId)
      .executeTakeFirstOrThrow();
    expect(payment).toEqual({ status: 'pending', amount: placed.totalCents, application_fee_amount: 12 });

    const res = await payOrder(placed.orderId, { buyer: BUYER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'paid', receipt: null, receiptError: 'SETTINGS_MISSING' });
    expect(await reserved(placed.inventoryItemId)).toBe(1);

    const again = await payOrder(placed.orderId, {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('payment_closed');
  });

  it('a buyer given with the order is enough to pay', async () => {
    const placed = await order(5, BUYER);
    expect((await payOrder(placed.orderId, {})).status).toBe(200);
  });

  it('a declined card: 402, the order closed and its stock released', async () => {
    const placed = await order(1);
    expect(await reserved(placed.inventoryItemId)).toBe(1);
    const res = await payOrder(placed.orderId, { buyer: BUYER, simulateDecline: true });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('payment_declined');
    expect(await reserved(placed.inventoryItemId)).toBe(0);
    expect((await payOrder(placed.orderId, { buyer: BUYER })).status).toBe(409);
  });

  it('no buyer: 422 and nothing is paid', async () => {
    const placed = await order();
    const res = await payOrder(placed.orderId, {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('buyer_required');
    const status = await tenant.db.selectFrom('order_payment').select('status').where('order_id', '=', placed.orderId).executeTakeFirstOrThrow();
    expect(status.status).toBe('pending');
  });

  it("another shop cannot pay this shop's order, and a malformed buyer is a 400", async () => {
    const placed = await order();
    expect((await payOrder(placed.orderId, { buyer: BUYER }, otherHost)).status).toBe(404);
    expect((await payOrder(placed.orderId, { buyer: { ...BUYER, email: 'not-an-email' } })).status).toBe(400);
  });

  it('an expired order is not paid: 409, its stock back', async () => {
    const placed = await order(1, BUYER);
    await letWindowRunOut(placed.orderId);
    const res = await payOrder(placed.orderId, {});
    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({ error: { code: 'payment_closed', status: 'expired' } });
    expect(await reserved(placed.inventoryItemId)).toBe(0);
  });

  it('paying sweeps only its own order: another expired hold waits for the job the order wrote', async () => {
    const abandoned = await order(1, BUYER);
    const buying = await order(5, BUYER);
    await letWindowRunOut(abandoned.orderId);

    expect((await payOrder(buying.orderId, {})).status).toBe(200);

    const row = await tenant.db
      .selectFrom('order_payment')
      .select('status')
      .where('order_id', '=', abandoned.orderId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(await reserved(abandoned.inventoryItemId)).toBe(1);
    const jobs = await tenant.db
      .selectFrom('commerce_job')
      .select(['kind', 'status'])
      .where('dedupe_key', '=', `expiry:${abandoned.orderId}`)
      .execute();
    expect(jobs).toEqual([{ kind: 'payment_expiry', status: 'pending' }]);
  });

  it('an expired order that cannot be closed stops only itself: another buyer pays, it takes no money', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stuck = await order(1, BUYER);
    const other = await order(5, BUYER);
    await letWindowRunOut(stuck.orderId);
    // The stock level no longer agrees with the hold, so its release is refused.
    const setReserved = (quantity: number) =>
      tenant.db
        .updateTable('inventory_level')
        .set({ reserved_quantity: quantity })
        .where('inventory_item_id', '=', stuck.inventoryItemId)
        .execute();
    await setReserved(0);

    expect((await payOrder(other.orderId, {})).status).toBe(200);
    expect((await payOrder(stuck.orderId, {})).status).toBe(500);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(stuck.orderId), expect.anything());

    // Once the cause is gone, the next attempt closes it.
    await setReserved(1);
    expect((await payOrder(stuck.orderId, {})).status).toBe(409);
    logged.mockRestore();
  });
});
