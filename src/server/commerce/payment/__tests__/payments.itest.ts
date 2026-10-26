// src/server/commerce/payment/__tests__/payments.itest.ts
//
// From a placed order to its receipt in the Books (docs/plans/2026-10-25-catalogue-design.md, slice 4),
// against real Postgres, with the demo provider and the same handler a real webhook uses. The four paths of
// the stateful-flow standard:
//
//   1. forward: pay, the payment is paid with its 1% fee, the receipt is issued in the company's series,
//      linked to the order, its lines and total those of the order, its service date the order's day;
//   2. declined (backtrack): the payment fails, the reserved stock goes back, no receipt; a new checkout works;
//   3. webhook twice (resume): a repeated event changes nothing and issues no second receipt; a receipt that
//      failed (the Books not set up yet) is issued on the next delivery once they are;
//   4. late (re-entry): an expired payment released its stock; a late success with the stock still there is
//      paid and gets its receipt, with the stock gone it is refunded and the order stays closed.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { catalogRepository } from '../../repository/catalog';
import { pricingRepository } from '../../repository/pricing';
import { createOrder } from '../../order/createOrder';
import { handlePaymentEvent, platformFee, sweepExpiredPayments, type PaymentDeps } from '../payments';
import { demoProvider, type PaymentEvent, type PaymentProvider } from '../provider';
import { berlinDay, ensureReceipt } from '../receipt';
import type { BuyerInput } from '../buyer';
import { booksScope } from '@/server/books/scope';
import { rejectionCode } from '@/server/books/__tests__/booksFixtures';
import {
  FakeContactBook,
  FakeDirectory,
  initCompany,
  openBooksEnv,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';

const BUYER: BuyerInput = {
  kind: 'person',
  name: 'Alex Example',
  email: 'alex@example.com',
  addressLine1: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
};

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('payments');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

interface Shop {
  company: string;
  dir: FakeDirectory;
  contacts: FakeContactBook;
  refunds: string[];
  deps: PaymentDeps;
  clock: { now: Date };
}

let shop: Shop;

/** A fresh company with the Books set up (regular VAT) and the payment handler wired to fakes. */
async function newShop(opts: { books?: boolean } = {}): Promise<Shop> {
  const company = randomUUID();
  const dir = new FakeDirectory();
  const contacts = new FakeContactBook(dir);
  const scope = booksScope(env.appDb, env.tgId, company, { recipients: dir });
  if (opts.books !== false) await initCompany(scope, { taxStatus: 'regular', invoiceNext: 1000 });
  const refunds: string[] = [];
  const clock = { now: new Date('2026-10-26T09:30:00Z') };
  const recordingProvider: PaymentProvider = {
    ...demoProvider,
    async refund(args) {
      refunds.push(args.providerPaymentId);
      return demoProvider.refund(args);
    },
  };
  return {
    company,
    dir,
    contacts,
    refunds,
    clock,
    deps: {
      db: env.appDb,
      tgId: env.tgId,
      provider: () => recordingProvider,
      receipt: (orderId) => ensureReceipt(scope, contacts, orderId, { now: clock.now }),
      now: () => clock.now,
    },
  };
}

beforeEach(async () => {
  shop = await newShop();
});

/** A published ring with a stocked variant (stock at a default location of its own). */
async function stockedRing(stock: number, priceCents = 4900) {
  const db = env.ownerDb;
  const p = await catalogRepository.createProduct(db, {
    tenantId: shop.company,
    title: 'Ring',
    handle: `ring-${randomUUID().slice(0, 8)}`,
    status: 'published',
  });
  const sku = `RING-${randomUUID()}`;
  const v = await catalogRepository.addVariant(db, { tenantId: shop.company, productId: p.id, sku, title: 'Silber' });
  const set = await pricingRepository.createPriceSet(db, { tenantId: shop.company, variantId: v.id });
  await pricingRepository.addPrice(db, { tenantId: shop.company, priceSetId: set.id, currency: 'EUR', amount: priceCents });
  const item = randomUUID();
  const location = randomUUID();
  await db.insertInto('inventory_item').values({ id: item, sku, updated_at: new Date() }).execute();
  await db.insertInto('stock_location').values({ id: location, name: `WH-${location}`, updated_at: new Date() }).execute();
  await db
    .insertInto('inventory_level')
    .values({ id: randomUUID(), inventory_item_id: item, location_id: location, stocked_quantity: stock, reserved_quantity: 0, updated_at: new Date() })
    .execute();
  return { variantId: v.id, item, location };
}

async function reserved(item: string): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('inventory_level')
    .select('reserved_quantity')
    .where('inventory_item_id', '=', item)
    .executeTakeFirstOrThrow();
  return row.reserved_quantity;
}

async function placeOrder(ring: Awaited<ReturnType<typeof stockedRing>>, quantity = 1, buyer: BuyerInput | null = BUYER) {
  const result = await createOrder(env.appDb, env.tgId, {
    tenantId: shop.company,
    siteId: 'site-shop',
    requestId: `rq-${randomUUID()}`,
    currency: 'EUR',
    taxRegion: 'DE',
    netOrGross: 'gross',
    now: shop.clock.now,
    lines: [
      {
        inventoryItemId: ring.item,
        variantId: ring.variantId,
        quantity,
        locationId: ring.location,
        variantRef: ring.variantId,
        variantRefSource: 'owned',
      },
    ],
    payment: { provider: 'demo', buyer: buyer as never },
  });
  if (!result.ok) throw new Error('the order was short');
  return result.orderId;
}

function event(orderId: string, type: PaymentEvent['type'], extra: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    provider: 'demo',
    eventId: `evt-${randomUUID()}`,
    type,
    tenantId: shop.company,
    orderId,
    providerPaymentId: `demo_pi_${orderId}`,
    ...extra,
  };
}

async function payment(orderId: string) {
  return env.ownerDb
    .selectFrom('order_payment')
    .selectAll()
    .where('tenant_id', '=', shop.company)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

async function receiptsOf(orderId: string) {
  return env.ownerDb
    .selectFrom('sales_document')
    .select(['id', 'status', 'document_number', 'total', 'service_date', 'customer_id'])
    .where('tenant_id', '=', shop.company)
    .where('source_order_id', '=', orderId)
    .execute();
}

describe('the platform fee', () => {
  it('is 1% rounded half up in cents', () => {
    expect(platformFee(999)).toBe(10);
    expect(platformFee(50)).toBe(1);
    expect(platformFee(49)).toBe(0);
    expect(platformFee(10000)).toBe(100);
    expect(() => platformFee(-1)).toThrow();
  });
});

describe('paying an order and its receipt', () => {
  it('forward: paid with its fee, the receipt issued in the series and linked to the order', async () => {
    const ring = await stockedRing(3, 4999);
    const orderId = await placeOrder(ring, 2);
    const opened = await payment(orderId);
    expect(opened).toMatchObject({ status: 'pending', amount: 9998, application_fee_amount: 100, currency_code: 'EUR' });
    expect(opened.expires_at.getTime() - shop.clock.now.getTime()).toBe(30 * 60 * 1000);
    expect(await reserved(ring.item)).toBe(2);

    const outcome = await handlePaymentEvent(shop.deps, event(orderId, 'payment_succeeded', { amount: 9998, currency: 'EUR' }));
    expect(outcome).toMatchObject({ status: 'paid', duplicate: false, receiptError: null });
    const [receipt] = await receiptsOf(orderId);
    expect(receipt).toMatchObject({ id: outcome.receiptDocumentId, status: 'issued', document_number: '1000', total: 9998 });
    // The service date is the Berlin day the order was placed. The order's created_at comes from the
    // database clock, not the fake one, so the expectation is read from the row rather than hardcoded.
    // A DATE column reads back as a local-midnight Date: compare its calendar day.
    const placed = await env.ownerDb.selectFrom('order').select('created_at').where('id', '=', orderId).executeTakeFirstOrThrow();
    const day = receipt.service_date as unknown as Date;
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(`${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`).toBe(berlinDay(new Date(placed.created_at)));
    const lines = await env.ownerDb
      .selectFrom('sales_document_line')
      .select(['kind', 'title', 'quantity', 'unit_price', 'tax_rate'])
      .where('document_id', '=', receipt.id)
      .execute();
    expect(lines).toEqual([{ kind: 'product', title: 'Silber', quantity: 2000, unit_price: 4999, tax_rate: 1900 }]);
    // The buyer became a contact and a customer of the company.
    expect(shop.contacts.created.map((c) => c.name)).toEqual(['Alex Example']);
    // The document of record is stored.
    const file = await env.ownerDb.selectFrom('sales_document_file').select('id').where('document_id', '=', receipt.id).execute();
    expect(file).toHaveLength(1);
    expect((await payment(orderId)).receipt_document_id).toBe(receipt.id);
    // Stock stays reserved for the paid order.
    expect(await reserved(ring.item)).toBe(2);
  });

  it('declined: the payment fails, the stock goes back, no receipt; a new checkout works', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    expect(await reserved(ring.item)).toBe(1);

    let outcome;
    await demoProvider.start(
      { tenantId: shop.company, orderId, orderNumber: 'x', amount: 4900, currency: 'EUR', applicationFeeAmount: 49, buyerEmail: BUYER.email, simulateDecline: true },
      async (e) => {
        outcome = await handlePaymentEvent(shop.deps, e);
      },
    );
    expect(outcome).toMatchObject({ status: 'failed', receiptDocumentId: null });
    expect(await payment(orderId)).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    expect(await reserved(ring.item)).toBe(0);
    expect(await receiptsOf(orderId)).toEqual([]);

    // The last unit is free again: a new checkout reserves and pays it.
    const again = await placeOrder(ring);
    expect((await handlePaymentEvent(shop.deps, event(again, 'payment_succeeded'))).status).toBe('paid');
  });

  it('webhook twice: the repeat changes nothing and issues no second receipt', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const e = event(orderId, 'payment_succeeded');
    const first = await handlePaymentEvent(shop.deps, e);
    const second = await handlePaymentEvent(shop.deps, e);
    expect(second).toEqual({ ...first, duplicate: true });
    expect(await receiptsOf(orderId)).toHaveLength(1);
    // A different event saying the same: also nothing new.
    const third = await handlePaymentEvent(shop.deps, event(orderId, 'payment_succeeded'));
    expect(third).toMatchObject({ status: 'paid', duplicate: false, receiptDocumentId: first.receiptDocumentId });
    expect(await receiptsOf(orderId)).toHaveLength(1);
    // A failure arriving after the success changes nothing either.
    expect((await handlePaymentEvent(shop.deps, event(orderId, 'payment_failed'))).status).toBe('paid');
    expect(await reserved(ring.item)).toBe(1);
  });

  it('resume: a receipt the Books could not issue yet is issued on the next delivery once they can', async () => {
    shop = await newShop({ books: false });
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const e = event(orderId, 'payment_succeeded');
    const first = await handlePaymentEvent(shop.deps, e);
    expect(first).toMatchObject({ status: 'paid', receiptDocumentId: null, receiptError: 'SETTINGS_MISSING' });
    expect((await payment(orderId)).receipt_error).toBe('SETTINGS_MISSING');
    expect(await receiptsOf(orderId)).toEqual([]);

    await initCompany(booksScope(env.appDb, env.tgId, shop.company, { recipients: shop.dir }), { taxStatus: 'regular' });
    const retried = await handlePaymentEvent(shop.deps, e);
    expect(retried).toMatchObject({ status: 'paid', duplicate: true, receiptError: null });
    expect(retried.receiptDocumentId).not.toBeNull();
    expect(await payment(orderId)).toMatchObject({ receipt_error: null, receipt_document_id: retried.receiptDocumentId });
  });

  it('no buyer yet: paid, the receipt waits for the buyer', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring, 1, null);
    const outcome = await handlePaymentEvent(shop.deps, event(orderId, 'payment_succeeded'));
    expect(outcome).toMatchObject({ status: 'paid', receiptDocumentId: null, receiptError: 'BUYER_MISSING' });
  });

  it('a reported amount other than the payment is refused and changes nothing', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    await expect(handlePaymentEvent(shop.deps, event(orderId, 'payment_succeeded', { amount: 1 }))).rejects.toThrow(/does not match/);
    expect((await payment(orderId)).status).toBe('pending');
    // Another company's order id is unknown.
    await expect(handlePaymentEvent(shop.deps, { ...event(orderId, 'payment_succeeded'), tenantId: randomUUID() })).rejects.toThrow(
      /no payment/,
    );
  });

  it('late with the stock still there: the expired order is paid after all and gets its receipt', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    shop.clock.now = new Date(shop.clock.now.getTime() + 31 * 60 * 1000);
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([orderId]);
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([]);
    expect((await payment(orderId)).status).toBe('expired');
    expect(await reserved(ring.item)).toBe(0);

    const late = await handlePaymentEvent(shop.deps, event(orderId, 'payment_succeeded'));
    expect(late).toMatchObject({ status: 'paid', receiptError: null });
    expect(await reserved(ring.item)).toBe(1);
    expect(await receiptsOf(orderId)).toHaveLength(1);
    expect(shop.refunds).toEqual([]);
  });

  it('declined, then paid in the same checkout: the paid payment keeps no closing time or decline code', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    await handlePaymentEvent(shop.deps, event(orderId, 'payment_failed', { failureCode: 'card_declined' }));
    expect(await payment(orderId)).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    expect((await payment(orderId)).closed_at).not.toBeNull();

    expect((await handlePaymentEvent(shop.deps, event(orderId, 'payment_succeeded'))).status).toBe('paid');
    expect(await payment(orderId)).toMatchObject({ status: 'paid', failure_code: null, closed_at: null });
    expect(await reserved(ring.item)).toBe(1);
  });

  it('late with the stock gone: refunded in full, the order stays closed, no receipt', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    expect((await handlePaymentEvent(shop.deps, event(orderId, 'checkout_cancelled'))).status).toBe('cancelled');
    // Someone else buys the last unit meanwhile.
    const other = await placeOrder(ring);
    await handlePaymentEvent(shop.deps, event(other, 'payment_succeeded'));

    const late = event(orderId, 'payment_succeeded');
    const outcome = await handlePaymentEvent(shop.deps, late);
    expect(outcome).toMatchObject({ status: 'refunded', receiptDocumentId: null });
    expect(await payment(orderId)).toMatchObject({ status: 'refunded', failure_code: 'stock_gone' });
    expect(shop.refunds).toEqual([`demo_pi_${orderId}`]);
    expect(await receiptsOf(orderId)).toEqual([]);
    expect(await reserved(ring.item)).toBe(1);
    // Delivered again: nothing changes, no second refund.
    expect((await handlePaymentEvent(shop.deps, late)).duplicate).toBe(true);
    expect(shop.refunds).toHaveLength(1);
  });
});

describe('021_order_payment guarantees, for every role', () => {
  it('refuses an illegal transition, a changed amount or fee, a moved receipt and any delete (BK018)', async () => {
    const ring = await stockedRing(3);
    const orderId = await placeOrder(ring);
    const update = (db: typeof env.ownerDb, set: Record<string, unknown>) =>
      db
        .updateTable('order_payment')
        .set(set as never)
        .where('tenant_id', '=', shop.company)
        .where('order_id', '=', orderId)
        .execute();
    for (const db of [env.ownerDb, env.appDb]) {
      expect(await rejectionCode(update(db, { status: 'refunded' }))).toBe('BK018');
      expect(await rejectionCode(update(db, { amount: 1 }))).toBe('BK018');
      expect(await rejectionCode(update(db, { application_fee_amount: 0 }))).toBe('BK018');
    }
    expect(
      await rejectionCode(env.ownerDb.deleteFrom('order_payment').where('order_id', '=', orderId).execute()),
    ).toBe('BK018');
    expect(await rejectionCode(env.appDb.deleteFrom('order_payment').where('order_id', '=', orderId).execute())).toBe(
      '42501',
    );

    const paid = await handlePaymentEvent(shop.deps, event(orderId, 'payment_succeeded'));
    expect(await rejectionCode(update(env.ownerDb, { receipt_document_id: null }))).toBe('BK018');
    expect(await rejectionCode(update(env.ownerDb, { status: 'pending' }))).toBe('BK018');
    // The buyer is fixed once the payment is decided.
    expect(await rejectionCode(update(env.ownerDb, { buyer: JSON.stringify({}) }))).toBe('BK018');
    expect(paid.receiptDocumentId).not.toBeNull();
  });

  it('a recorded provider event never changes or goes (BK019; the app role holds no right to try)', async () => {
    const ring = await stockedRing(3);
    const orderId = await placeOrder(ring);
    await handlePaymentEvent(shop.deps, event(orderId, 'payment_failed'));
    const tamper = env.ownerDb.updateTable('payment_event').set({ event_type: 'payment_succeeded' }).where('order_id', '=', orderId);
    expect(await rejectionCode(tamper.execute())).toBe('BK019');
    expect(await rejectionCode(env.ownerDb.deleteFrom('payment_event').where('order_id', '=', orderId).execute())).toBe('BK019');
    expect(await rejectionCode(env.appDb.deleteFrom('payment_event').where('order_id', '=', orderId).execute())).toBe('42501');
  });
});
