// src/app/api/commerce/orders/[orderId]/pay/__tests__/demoCheckout.itest.ts
//
// The demo checkout is for the demo company only (decided on 2026-11-02 after the money review, finding 4). The demo
// provider moves no money, yet marks an order paid and issues a real, numbered invoice; on any other shop a visitor
// could make invoices for sales that never happened. Through the real order and pay routes on Postgres, with no Stripe
// keys, so every company without Stripe would otherwise get the demo provider:
//
//   - forward: the demo company still places a demo order and pays it, with its receipt;
//   - backtrack: another company's shop refuses checkout with 503 payments_unavailable before anything is reserved, and
//     nothing is ordered;
//   - re-entry: a demo order that company placed before this rule is refused at pay, stays pending, gets no invoice;
//     asking again is the same refusal.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: null as unknown, contactBook: null as unknown }));

vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));

import { DEMO_COMPANY_ID } from '@/lib/renderer/server/demoTenant';
import { FakeContactBook, FakeDirectory, initCompany } from '@/server/books/__tests__/booksFixtures';
import { booksScope } from '@/server/books/scope';
import {
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { createOrder } from '@/server/commerce/order/createOrder';
import { POST as placeOrder } from '../../../route';
import { POST as pay } from '../route';

let fx: StorefrontFixtures;
let tenant: ProvisionedTenant;
let demoHost: string;
let otherHost: string;
const OTHER_COMPANY = randomUUID();

const PROVISIONING_TIMEOUT = 300_000;

const BUYER = {
  name: 'Alex Example',
  email: 'alex@example.com',
  addressLine1: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
};

beforeAll(async () => {
  const directory = new FakeDirectory();
  state.directory = directory;
  state.contactBook = new FakeContactBook(directory);
  fx = openStorefrontFixtures();
  tenant = await provisionCommerceTenant(fx, 'demo-only');
  demoHost = (await createPublishedSite(fx, tenant.tgId, 'demo-only-demo')).host;
  otherHost = (await createPublishedSite(fx, tenant.tgId, 'demo-only-other', OTHER_COMPANY)).host;
  for (const company of [DEMO_COMPANY_ID, OTHER_COMPANY]) {
    // Both have their Books: what refuses the other company is the missing Stripe account alone.
    await initCompany(booksScope(tenant.db, tenant.tgId, company, { recipients: directory }), { taxStatus: 'regular', invoiceNext: 1000 });
  }
}, PROVISIONING_TIMEOUT);

afterAll(async () => {
  await fx?.close();
});

function request(host: string, path: string, body: unknown): Request {
  return new Request(`http://${host}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify(body),
  });
}

async function product(tenantId: string) {
  return seedBuyableProduct(tenant.db, { title: `P-${randomUUID().slice(0, 6)}`, handle: `p-${randomUUID()}`, amountCents: 1000, stocked: 5, tenantId });
}

async function payOrder(host: string, orderId: string) {
  const res = await pay(request(host, `/api/commerce/orders/${orderId}/pay`, { buyer: BUYER }), { params: Promise.resolve({ orderId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function reserved(item: string) {
  const level = await tenant.db.selectFrom('inventory_level').select('reserved_quantity').where('inventory_item_id', '=', item).executeTakeFirstOrThrow();
  return level.reserved_quantity;
}

async function ordersOf(company: string) {
  return tenant.db.selectFrom('order').select('id').where('tenant_id', '=', company).execute();
}

describe('the demo checkout, for the demo company only', () => {
  it('forward: the demo company places a demo order and pays it, with its receipt', async () => {
    const seeded = await product(DEMO_COMPANY_ID);
    const placed = await placeOrder(request(demoHost, '/api/commerce/orders', { lines: [{ variantId: seeded.variantId, quantity: 1 }] }));
    expect(placed.status).toBe(201);
    const body = (await placed.json()) as { orderId: string; provider: string };
    expect(body.provider).toBe('demo');
    expect(await payOrder(demoHost, body.orderId)).toMatchObject({ status: 200, body: { status: 'paid', receiptError: null } });
  });

  it('backtrack: any other shop without Stripe refuses checkout before anything is reserved', async () => {
    const seeded = await product(OTHER_COMPANY);
    const res = await placeOrder(request(otherHost, '/api/commerce/orders', { lines: [{ variantId: seeded.variantId, quantity: 1 }] }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'payments_unavailable', message: expect.stringContaining('Nothing has been charged') } });
    expect(await ordersOf(OTHER_COMPANY)).toEqual([]);
    expect(await reserved(seeded.inventoryItemId)).toBe(0);
  });

  it('re-entry: a demo order that shop placed before this rule is never paid, nor invoiced', async () => {
    const seeded = await product(OTHER_COMPANY);
    const placed = await createOrder(tenant.db, tenant.tgId, {
      tenantId: OTHER_COMPANY,
      siteId: 'site-other',
      requestId: `rq-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      netOrGross: 'net',
      lines: [{ inventoryItemId: seeded.inventoryItemId, variantId: seeded.variantId, quantity: 1, variantRef: seeded.variantId, variantRefSource: 'owned' }],
      payment: { provider: 'demo', buyer: null },
    });
    if (!placed.ok) throw new Error('the order was short');
    const first = await payOrder(otherHost, placed.orderId);
    expect(first).toMatchObject({ status: 503, body: { error: { code: 'payments_unavailable' } } });
    expect(await payOrder(otherHost, placed.orderId)).toEqual(first);
    const payment = await tenant.db
      .selectFrom('order_payment')
      .select(['status', 'buyer'])
      .where('tenant_id', '=', OTHER_COMPANY)
      .where('order_id', '=', placed.orderId)
      .executeTakeFirstOrThrow();
    expect(payment).toEqual({ status: 'pending', buyer: {} });
    const documents = await tenant.db.selectFrom('sales_document').select('id').where('source_order_id', '=', placed.orderId).execute();
    expect(documents).toEqual([]);
  });
});
