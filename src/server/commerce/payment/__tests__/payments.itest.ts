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
//      failed (the Books not set up yet) is issued by its job once they are, while a repeated delivery writes nothing;
//   4. late (re-entry): an expired payment released its stock; a late success with the stock still there is
//      paid and gets its receipt, with the stock gone it is refunded and the order stays closed.
// The expiry sweep on its own: two sweeps at once release once (each truly waiting on the same payment row), a
// payment racing a sweep ends paid with its stock held, and one payment that cannot be closed keeps no other
// from closing.
// Since slice B4 a payment that becomes paid writes its receipt's job, and `settle` below runs it as a route does
// right after the event; receiptJob.itest.ts covers the job itself.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { catalogRepository } from '../../repository/catalog';
import { pricingRepository } from '../../repository/pricing';
import { createOrder } from '../../order/createOrder';
import { emitCommerceEvent } from '../../jobs/emit';
import { runJobNow } from '../../jobs/run';
import { ExpirySweepError, handlePaymentEvent, platformFee, sweepExpiredPayments, type PaymentDeps } from '../payments';
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
      emit: (trx, e) => emitCommerceEvent(trx, e),
      now: () => clock.now,
    },
  };
}

const MINUTE = 60 * 1000;

/** What a run of the job worker needs to act as this shop: its payment wiring and its clock. */
function jobOptions() {
  return {
    paymentDeps: (_group: unknown, tenantId: string) => {
      if (tenantId !== shop.company) throw new Error(`a job of company ${tenantId} reached the wiring of ${shop.company}`);
      return shop.deps;
    },
    now: () => shop.clock.now,
  };
}

/**
 * Apply an event as a route does: the payment's change, then the first attempt at each job it wrote. Answers the
 * outcome with the receipt as the payment holds it afterwards.
 */
async function settle(e: PaymentEvent) {
  const outcome = await handlePaymentEvent(shop.deps, e);
  for (const id of outcome.jobIds) await runJobNow({ id: env.tgId, db: env.appDb }, shop.company, id, jobOptions());
  const row = await payment(e.orderId);
  return { ...outcome, receiptDocumentId: row.receipt_document_id, receiptError: row.receipt_error };
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
    // A Stripe payment: these companies are not the demo company, whose demo payments alone owe an invoice (demoCheckout.ts).
    payment: { provider: 'stripe', buyer: buyer as never },
  });
  if (!result.ok) throw new Error('the order was short');
  return result.orderId;
}

function event(orderId: string, type: PaymentEvent['type'], extra: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    provider: 'stripe',
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
  it('each receipt is made out to the buyer as entered for its order, even under a name an earlier order used', async () => {
    const ring = await stockedRing(3, 4999);
    const first = await placeOrder(ring, 1);
    await settle(event(first, 'payment_succeeded'));
    // The same name buys again from another address, with another email: the contacts database knows one person
    // of that name, but this invoice must carry this order's address.
    const moved: BuyerInput = { ...BUYER, email: 'alex.new@example.com', addressLine1: 'Neue Straße 9', postalCode: '10115', city: 'Berlin' };
    const second = await placeOrder(ring, 1, moved);
    await settle(event(second, 'payment_succeeded'));

    const snapshot = async (orderId: string) => {
      const row = await env.ownerDb
        .selectFrom('sales_document')
        .select('customer_snapshot')
        .where('tenant_id', '=', shop.company)
        .where('source_order_id', '=', orderId)
        .executeTakeFirstOrThrow();
      return row.customer_snapshot as unknown as { name: string; addressLine1: string; postalCode: string; city: string };
    };
    expect(await snapshot(first)).toMatchObject({ name: 'Alex Example', addressLine1: 'Beispielweg 2', postalCode: '20095', city: 'Hamburg' });
    expect(await snapshot(second)).toMatchObject({ name: 'Alex Example', addressLine1: 'Neue Straße 9', postalCode: '10115', city: 'Berlin' });
  });

  it('a buyer of the same name with another VAT id gets no receipt showing the first buyer\'s tax identity', async () => {
    const ring = await stockedRing(3, 4999);
    const first = await placeOrder(ring, 1);
    await settle(event(first, 'payment_succeeded'));
    const business: BuyerInput = { ...BUYER, vatId: 'DE123456789' };
    const second = await placeOrder(ring, 1, business);
    const outcome = await settle(event(second, 'payment_succeeded'));
    expect(outcome).toMatchObject({ status: 'paid', receiptDocumentId: null, receiptError: 'TAX_IDENTITY_MISMATCH' });
    expect(await receiptsOf(second)).toEqual([]);
  });

  it('forward: paid with its fee, the receipt issued in the series and linked to the order', async () => {
    const ring = await stockedRing(3, 4999);
    const orderId = await placeOrder(ring, 2);
    const opened = await payment(orderId);
    expect(opened).toMatchObject({ status: 'pending', amount: 9998, application_fee_amount: 100, currency_code: 'EUR' });
    expect(opened.expires_at.getTime() - shop.clock.now.getTime()).toBe(30 * 60 * 1000);
    expect(await reserved(ring.item)).toBe(2);

    const outcome = await settle(event(orderId, 'payment_succeeded', { amount: 9998, currency: 'EUR' }));
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
    // Named as the cart names it: the product and its variant.
    expect(lines).toEqual([{ kind: 'product', title: 'Ring, Silber', quantity: 2000, unit_price: 4999, tax_rate: 1900 }]);
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
        outcome = await settle(e);
      },
    );
    expect(outcome).toMatchObject({ status: 'failed', receiptDocumentId: null });
    expect(await payment(orderId)).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    expect(await reserved(ring.item)).toBe(0);
    expect(await receiptsOf(orderId)).toEqual([]);

    // The last unit is free again: a new checkout reserves and pays it.
    const again = await placeOrder(ring);
    expect((await settle(event(again, 'payment_succeeded'))).status).toBe('paid');
  });

  it('webhook twice: the repeat changes nothing and issues no second receipt', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const e = event(orderId, 'payment_succeeded');
    const first = await settle(e);
    const second = await settle(e);
    expect(second).toEqual({ ...first, duplicate: true, jobIds: [] });
    expect(await receiptsOf(orderId)).toHaveLength(1);
    // A different event saying the same: also nothing new.
    const third = await settle(event(orderId, 'payment_succeeded'));
    expect(third).toMatchObject({ status: 'paid', duplicate: false, receiptDocumentId: first.receiptDocumentId });
    expect(await receiptsOf(orderId)).toHaveLength(1);
    // A failure arriving after the success changes nothing either.
    expect((await settle(event(orderId, 'payment_failed'))).status).toBe('paid');
    expect(await reserved(ring.item)).toBe(1);
  });

  it('resume: a receipt the Books could not issue yet is issued by its job once they can, not by a repeat', async () => {
    shop = await newShop({ books: false });
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const e = event(orderId, 'payment_succeeded');
    const first = await settle(e);
    expect(first).toMatchObject({ status: 'paid', receiptDocumentId: null, receiptError: 'SETTINGS_MISSING' });
    expect(await receiptsOf(orderId)).toEqual([]);

    await initCompany(booksScope(env.appDb, env.tgId, shop.company, { recipients: shop.dir }), { taxStatus: 'regular' });
    // A repeated delivery is a repeat: it writes no job and issues nothing.
    const repeated = await settle(e);
    expect(repeated).toMatchObject({ status: 'paid', duplicate: true, jobIds: [], receiptDocumentId: null });
    // The job's next attempt, a minute later, issues it.
    const job = await env.ownerDb
      .selectFrom('commerce_job')
      .select(['id', 'status', 'last_error'])
      .where('tenant_id', '=', shop.company)
      .where('kind', '=', 'receipt_issue')
      .executeTakeFirstOrThrow();
    expect(job).toMatchObject({ status: 'pending', last_error: 'SETTINGS_MISSING' });
    shop.clock.now = new Date(shop.clock.now.getTime() + MINUTE);
    expect(await runJobNow({ id: env.tgId, db: env.appDb }, shop.company, job.id, jobOptions())).toMatchObject({ outcome: 'done' });
    const after = await payment(orderId);
    expect(after.receipt_error).toBeNull();
    expect(after.receipt_document_id).not.toBeNull();
    expect(await receiptsOf(orderId)).toHaveLength(1);
  });

  it('no buyer yet: paid, the receipt waits for the buyer', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring, 1, null);
    const outcome = await settle(event(orderId, 'payment_succeeded'));
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

    const late = await settle(event(orderId, 'payment_succeeded'));
    expect(late).toMatchObject({ status: 'paid', receiptError: null });
    expect(await reserved(ring.item)).toBe(1);
    expect(await receiptsOf(orderId)).toHaveLength(1);
    expect(shop.refunds).toEqual([]);
  });

  it('declined, then paid in the same checkout: the paid payment keeps no closing time or decline code', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    await settle(event(orderId, 'payment_failed', { failureCode: 'card_declined' }));
    expect(await payment(orderId)).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    expect((await payment(orderId)).closed_at).not.toBeNull();

    expect((await settle(event(orderId, 'payment_succeeded'))).status).toBe('paid');
    expect(await payment(orderId)).toMatchObject({ status: 'paid', failure_code: null, closed_at: null });
    expect(await reserved(ring.item)).toBe(1);
  });

  it('late with the stock gone: refunded in full, the order stays closed, no receipt', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    expect((await settle(event(orderId, 'checkout_cancelled'))).status).toBe('cancelled');
    // Someone else buys the last unit meanwhile.
    const other = await placeOrder(ring);
    await settle(event(other, 'payment_succeeded'));

    const late = event(orderId, 'payment_succeeded');
    const outcome = await settle(late);
    expect(outcome).toMatchObject({ status: 'refunded', receiptDocumentId: null });
    expect(await payment(orderId)).toMatchObject({ status: 'refunded', failure_code: 'stock_gone' });
    expect(shop.refunds).toEqual([`demo_pi_${orderId}`]);
    expect(await receiptsOf(orderId)).toEqual([]);
    expect(await reserved(ring.item)).toBe(1);
    // Delivered again: nothing changes, no second refund.
    expect((await settle(late)).duplicate).toBe(true);
    expect(shop.refunds).toHaveLength(1);
  });
});

describe('the expiry sweep', () => {
  const WINDOW_RAN_OUT = 31 * 60 * 1000;
  const runOutWindow = () => {
    shop.clock.now = new Date(shop.clock.now.getTime() + WINDOW_RAN_OUT);
  };

  async function ledger(orderId: string) {
    const events = await env.ownerDb.selectFrom('payment_event').select('event_id').where('order_id', '=', orderId).execute();
    const releases = await env.ownerDb
      .selectFrom('stock_movement')
      .select('quantity')
      .where('movement_type', '=', 'release')
      .where('ref_id', '=', orderId)
      .execute();
    return { events: events.map((e) => e.event_id), released: releases.map((r) => r.quantity) };
  }

  /**
   * Run `calls` while another transaction holds the payment row, and let go only once `calls.length` of them wait
   * on it. Every caller has then passed its own read of what is due and arrives at the lock at the same moment:
   * the overlap is forced, not left to the scheduler.
   */
  async function raceOnPaymentRow<T>(orderId: string, calls: Array<() => Promise<T>>): Promise<T[]> {
    let waiting: Promise<T[]> | undefined;
    await env.ownerDb.transaction().execute(async (trx) => {
      await trx.selectFrom('order_payment').select('order_id').where('order_id', '=', orderId).forUpdate().execute();
      waiting = Promise.all(calls.map((call) => call()));
      // The first waiter queues on this transaction, the others on the row's tuple lock behind it.
      await vi.waitFor(
        async () => {
          const blocked = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted
               AND (transactionid = pg_current_xact_id()::xid
                    OR (locktype = 'tuple' AND relation = to_regclass(${`"${env.schema}".order_payment`})))
          `.execute(trx);
          expect(blocked.rows[0].n).toBe(calls.length);
        },
        { timeout: 10_000, interval: 25 },
      );
    });
    return waiting as Promise<T[]>;
  }

  it('forward: closes only what ran out, and a second sweep changes nothing', async () => {
    const ring = await stockedRing(3);
    const abandoned = await placeOrder(ring);
    runOutWindow();
    const live = await placeOrder(ring);

    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([abandoned]);
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([]);
    expect((await payment(abandoned)).status).toBe('expired');
    expect((await payment(live)).status).toBe('pending');
    expect(await reserved(ring.item)).toBe(1);
    expect(await ledger(abandoned)).toEqual({ events: [`expiry:${abandoned}`], released: [1] });
  });

  it('two sweeps at once release once, even with other holds on the same stock to over-release into', async () => {
    const ring = await stockedRing(5);
    const abandoned = await placeOrder(ring, 2);
    runOutWindow();
    const live = await placeOrder(ring, 2);

    const answers = await raceOnPaymentRow(abandoned, [
      () => sweepExpiredPayments(shop.deps, shop.company),
      () => sweepExpiredPayments(shop.deps, shop.company),
    ]);
    expect(answers.flat()).toEqual([abandoned]);
    expect(await reserved(ring.item)).toBe(2);
    expect((await payment(live)).status).toBe('pending');
    expect(await ledger(abandoned)).toEqual({ events: [`expiry:${abandoned}`], released: [2] });
  });

  it('the same expiry event delivered twice at once: exactly one takes effect', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const expiry = event(orderId, 'checkout_expired', { eventId: `expiry:${orderId}` });

    const outcomes = await raceOnPaymentRow(orderId, [
      () => handlePaymentEvent(shop.deps, expiry),
      () => handlePaymentEvent(shop.deps, expiry),
    ]);
    expect(outcomes.map((o) => o.duplicate).sort()).toEqual([false, true]);
    expect(outcomes.map((o) => o.status)).toEqual(['expired', 'expired']);
    expect(await reserved(ring.item)).toBe(0);
    expect(await ledger(orderId)).toEqual({ events: [`expiry:${orderId}`], released: [1] });
  });

  it('a success racing a sweep ends paid with its stock held, whichever wins the row', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    runOutWindow();

    await raceOnPaymentRow<unknown>(orderId, [
      () => sweepExpiredPayments(shop.deps, shop.company),
      () => settle(event(orderId, 'payment_succeeded')),
    ]);
    expect((await payment(orderId)).status).toBe('paid');
    expect(await reserved(ring.item)).toBe(1);
    expect(await receiptsOf(orderId)).toHaveLength(1);
    expect(shop.refunds).toEqual([]);
  });

  it('re-entry: a sweep gave the unit to another buyer, the late success is refunded and the new order stands', async () => {
    const ring = await stockedRing(1);
    const abandoned = await placeOrder(ring);
    runOutWindow();
    await sweepExpiredPayments(shop.deps, shop.company);
    const next = await placeOrder(ring);

    const late = await settle(event(abandoned, 'payment_succeeded'));
    expect(late).toMatchObject({ status: 'refunded', receiptDocumentId: null });
    expect(await payment(abandoned)).toMatchObject({ status: 'refunded', failure_code: 'stock_gone' });
    expect(shop.refunds).toEqual([`demo_pi_${abandoned}`]);
    expect((await payment(next)).status).toBe('pending');
    expect(await reserved(ring.item)).toBe(1);
  });

  it('resume: a late success keeps its stock, and later sweeps never release it', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    runOutWindow();
    await sweepExpiredPayments(shop.deps, shop.company);
    await settle(event(orderId, 'payment_succeeded'));

    runOutWindow();
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([]);
    expect((await payment(orderId)).status).toBe('paid');
    expect(await reserved(ring.item)).toBe(1);
  });

  it('touches only its own company', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    runOutWindow();
    const other = await newShop();
    other.clock.now = shop.clock.now;

    expect(await sweepExpiredPayments(other.deps, other.company)).toEqual([]);
    expect((await payment(orderId)).status).toBe('pending');
  });

  it('one payment that cannot be closed keeps no other from closing, is reported, and closes on a later sweep', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poisoned = await stockedRing(1);
    const healthy = await stockedRing(1);
    const stuck = await placeOrder(poisoned);
    const closes = await placeOrder(healthy);
    runOutWindow();
    // The stock level no longer agrees with the hold, so its release is refused.
    await env.ownerDb.updateTable('inventory_level').set({ reserved_quantity: 0 }).where('inventory_item_id', '=', poisoned.item).execute();

    const failure = await sweepExpiredPayments(shop.deps, shop.company).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ExpirySweepError);
    expect(failure).toMatchObject({ closed: [closes], failed: [stuck] });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(stuck), expect.anything());
    expect((await payment(closes)).status).toBe('expired');
    // Nothing of the failed close stuck: no event, so the next sweep tries it afresh.
    expect(await payment(stuck)).toMatchObject({ status: 'pending' });
    expect((await ledger(stuck)).events).toEqual([]);

    await env.ownerDb.updateTable('inventory_level').set({ reserved_quantity: 1 }).where('inventory_item_id', '=', poisoned.item).execute();
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([stuck]);
    logged.mockRestore();
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

    const paid = await settle(event(orderId, 'payment_succeeded'));
    expect(await rejectionCode(update(env.ownerDb, { receipt_document_id: null }))).toBe('BK018');
    expect(await rejectionCode(update(env.ownerDb, { status: 'pending' }))).toBe('BK018');
    // The buyer is fixed once the payment is decided.
    expect(await rejectionCode(update(env.ownerDb, { buyer: JSON.stringify({}) }))).toBe('BK018');
    expect(paid.receiptDocumentId).not.toBeNull();
  });

  it('a recorded provider event never changes or goes (BK019; the app role holds no right to try)', async () => {
    const ring = await stockedRing(3);
    const orderId = await placeOrder(ring);
    await settle(event(orderId, 'payment_failed'));
    const tamper = env.ownerDb.updateTable('payment_event').set({ event_type: 'payment_succeeded' }).where('order_id', '=', orderId);
    expect(await rejectionCode(tamper.execute())).toBe('BK019');
    expect(await rejectionCode(env.ownerDb.deleteFrom('payment_event').where('order_id', '=', orderId).execute())).toBe('BK019');
    expect(await rejectionCode(env.appDb.deleteFrom('payment_event').where('order_id', '=', orderId).execute())).toBe('42501');
  });
});
