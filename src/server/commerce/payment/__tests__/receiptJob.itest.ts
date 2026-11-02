// src/server/commerce/payment/__tests__/receiptJob.itest.ts
//
// The receipt job (docs/plans/2026-11-02-shop-backbone.md, slice B4) against real Postgres, as the app role, through
// the real registry and the real Books issue: a payment that becomes paid writes the job in the same transaction, and
// the job issues, links and announces the receipt. Test names follow the stateful flow standard: F forward, B backtrack,
// R resume, E re-entry. The clock is passed in, so a retry comes due without waiting for it.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { booksScope } from '@/server/books/scope';
import { initBooksCompany } from '@/server/books/settings';
import {
  FakeContactBook,
  FakeDirectory,
  initCompany,
  openBooksEnv,
  syntheticSender,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';
import { runJobBackfills } from '../../jobs/backfills';
import { emitCommerceEvent } from '../../jobs/emit';
import { runJobNow, type JobRunOptions } from '../../jobs/run';
import type { CommerceEvent } from '../../jobs/types';
import { createOrder } from '../../order/createOrder';
import { catalogRepository } from '../../repository/catalog';
import { pricingRepository } from '../../repository/pricing';
import type { BuyerInput } from '../buyer';
import { handlePaymentEvent, issueReceipt, type PaymentDeps } from '../payments';
import { demoProvider, type PaymentEvent } from '../provider';
import { berlinDay, ensureReceipt } from '../receipt';
import { RECEIPT_ISSUE_KIND } from '../receiptJob';

const BUYER: BuyerInput = {
  kind: 'person',
  name: 'Alex Example',
  email: 'alex@example.com',
  addressLine1: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// 23:30 in Berlin: a retry the next morning is another day, so the receipt's payment day shows where it comes from.
const T0 = new Date('2026-10-26T22:30:00.000Z');

let env: BooksEnv;

interface Shop {
  company: string;
  dir: FakeDirectory;
  clock: { now: Date };
  /** Every event this shop's payments wrote, in order. */
  emitted: CommerceEvent[];
  deps: PaymentDeps;
}

let shop: Shop;

function scopeOf(s: Shop) {
  return booksScope(env.appDb, env.tgId, s.company, { recipients: s.dir });
}

async function newShop(opts: { books?: boolean } = {}): Promise<Shop> {
  const company = randomUUID();
  const dir = new FakeDirectory();
  const contacts = new FakeContactBook(dir);
  const clock = { now: T0 };
  const emitted: CommerceEvent[] = [];
  const created: Shop = {
    company,
    dir,
    clock,
    emitted,
    deps: {
      db: env.appDb,
      tgId: env.tgId,
      provider: () => demoProvider,
      receipt: (orderId) => ensureReceipt(booksScope(env.appDb, env.tgId, company, { recipients: dir }), contacts, orderId, { now: clock.now }),
      emit: async (trx, event) => {
        emitted.push(event);
        return emitCommerceEvent(trx, event);
      },
      now: () => clock.now,
    },
  };
  if (opts.books !== false) await initCompany(scopeOf(created), { taxStatus: 'regular', invoiceNext: 1000 });
  return created;
}

beforeAll(async () => {
  env = await openBooksEnv('receipt-job');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

beforeEach(async () => {
  shop = await newShop();
});

const group = () => ({ id: env.tgId, db: env.appDb });

/** The worker's options for these shops: each job gets the wiring of its own company, and only that. */
function worker(...shops: Shop[]): JobRunOptions {
  return {
    paymentDeps: (_group, tenantId) => {
      const owner = shops.find((s) => s.company === tenantId);
      if (!owner) throw new Error(`no wiring for company ${tenantId}`);
      return owner.deps;
    },
    now: () => shops[0].clock.now,
  };
}

async function stockedRing(s: Shop, priceCents = 4900) {
  const db = env.ownerDb;
  const p = await catalogRepository.createProduct(db, { tenantId: s.company, title: 'Ring', handle: `ring-${randomUUID().slice(0, 8)}`, status: 'published' });
  const sku = `RING-${randomUUID()}`;
  const v = await catalogRepository.addVariant(db, { tenantId: s.company, productId: p.id, sku, title: 'Silber' });
  const set = await pricingRepository.createPriceSet(db, { tenantId: s.company, variantId: v.id });
  await pricingRepository.addPrice(db, { tenantId: s.company, priceSetId: set.id, currency: 'EUR', amount: priceCents });
  const item = randomUUID();
  const location = randomUUID();
  await db.insertInto('inventory_item').values({ id: item, sku, updated_at: new Date() }).execute();
  await db.insertInto('stock_location').values({ id: location, name: `WH-${location}`, updated_at: new Date() }).execute();
  await db
    .insertInto('inventory_level')
    .values({ id: randomUUID(), inventory_item_id: item, location_id: location, stocked_quantity: 5, reserved_quantity: 0, updated_at: new Date() })
    .execute();
  return { variantId: v.id, item, location };
}

async function placeOrder(s: Shop, opts: { netOrGross?: 'net' | 'gross' } = {}) {
  const ring = await stockedRing(s);
  const result = await createOrder(env.appDb, env.tgId, {
    tenantId: s.company,
    siteId: 'site-shop',
    requestId: `rq-${randomUUID()}`,
    currency: 'EUR',
    taxRegion: 'DE',
    netOrGross: opts.netOrGross ?? 'gross',
    now: s.clock.now,
    lines: [{ inventoryItemId: ring.item, variantId: ring.variantId, quantity: 1, locationId: ring.location, variantRef: ring.variantId, variantRefSource: 'owned' }],
    payment: { provider: 'demo', buyer: BUYER as never },
  });
  if (!result.ok) throw new Error('the order was short');
  return result.orderId;
}

function paid(s: Shop, orderId: string, extra: Partial<PaymentEvent> = {}): PaymentEvent {
  return { provider: 'demo', eventId: `evt-${randomUUID()}`, type: 'payment_succeeded', tenantId: s.company, orderId, providerPaymentId: `demo_pi_${orderId}`, ...extra };
}

function payment(s: Shop, orderId: string) {
  return env.ownerDb.selectFrom('order_payment').selectAll().where('tenant_id', '=', s.company).where('order_id', '=', orderId).executeTakeFirstOrThrow();
}

function receiptJobs(s: Shop, orderId: string) {
  return env.ownerDb
    .selectFrom('commerce_job')
    .selectAll()
    .where('tenant_id', '=', s.company)
    .where('kind', '=', RECEIPT_ISSUE_KIND)
    .where('dedupe_key', '=', `receipt:${orderId}`)
    .execute();
}

function receiptsOf(s: Shop, orderId: string) {
  return env.ownerDb
    .selectFrom('sales_document')
    .select(['id', 'status', (eb) => eb.cast<string>('paid_on', 'text').as('paid_on')])
    .where('tenant_id', '=', s.company)
    .where('source_order_id', '=', orderId)
    .execute();
}

describe('the receipt job', () => {
  it('F: paid writes the job with the change; its run issues, links and announces the receipt on the payment day', async () => {
    const orderId = await placeOrder(shop);
    const outcome = await handlePaymentEvent(shop.deps, paid(shop, orderId));
    expect(outcome).toMatchObject({ status: 'paid', duplicate: false });
    const [job] = await receiptJobs(shop, orderId);
    expect(job).toMatchObject({ status: 'pending', event_type: 'payment.paid', payload: { orderId } });
    expect(outcome.jobIds).toEqual([job.id]);
    // Nothing is issued until the job runs: the payment no longer waits on the Books.
    expect(await receiptsOf(shop, orderId)).toEqual([]);

    expect(await runJobNow(group(), shop.company, job.id, worker(shop))).toMatchObject({ outcome: 'done' });
    const [receipt] = await receiptsOf(shop, orderId);
    expect(receipt).toMatchObject({ status: 'issued', paid_on: berlinDay(T0) });
    expect(await payment(shop, orderId)).toMatchObject({ receipt_document_id: receipt.id, receipt_error: null });
    // The payment's own events, in order (the order's `order.placed` is written by createOrder itself).
    expect(shop.emitted.map((e) => [e.type, e.payload])).toEqual([
      ['payment.paid', { orderId }],
      ['receipt.issued', { orderId }],
    ]);
    expect((await receiptJobs(shop, orderId))[0]).toMatchObject({ status: 'done' });
  });

  it('B: a status change that does not commit leaves no job', async () => {
    const orderId = await placeOrder(shop);
    // Another amount: refused before anything is written.
    await expect(handlePaymentEvent(shop.deps, paid(shop, orderId, { amount: 1 }))).rejects.toThrow(/does not match/);
    // The job is written, then the transaction fails after it: the job goes with it.
    const failing: PaymentDeps = {
      ...shop.deps,
      emit: async (trx, event) => {
        await emitCommerceEvent(trx, event);
        throw new Error('the transaction fails after the job was written');
      },
    };
    await expect(handlePaymentEvent(failing, paid(shop, orderId))).rejects.toThrow(/fails after/);
    expect(await receiptJobs(shop, orderId)).toEqual([]);
    expect((await payment(shop, orderId)).status).toBe('pending');
  });

  it('R: Books missing at the first attempt; the job keeps the reason, retries, and issues once they exist, dated the payment day', async () => {
    shop = await newShop({ books: false });
    const orderId = await placeOrder(shop);
    const { jobIds } = await handlePaymentEvent(shop.deps, paid(shop, orderId));
    expect(await runJobNow(group(), shop.company, jobIds[0], worker(shop))).toMatchObject({ outcome: 'retry' });
    expect(await payment(shop, orderId)).toMatchObject({ status: 'paid', receipt_document_id: null, receipt_error: 'SETTINGS_MISSING' });
    expect((await receiptJobs(shop, orderId))[0]).toMatchObject({ status: 'pending', last_error: 'SETTINGS_MISSING' });

    // The next morning the company sets up its Books, and the job comes round.
    shop.clock.now = new Date(T0.getTime() + DAY);
    await initCompany(scopeOf(shop), { taxStatus: 'regular', invoiceNext: 1000 });
    expect(await runJobNow(group(), shop.company, jobIds[0], worker(shop))).toMatchObject({ outcome: 'done' });
    const [receipt] = await receiptsOf(shop, orderId);
    expect(receipt).toMatchObject({ status: 'issued', paid_on: berlinDay(T0) });
    expect(berlinDay(T0)).not.toBe(berlinDay(shop.clock.now));
    expect(await payment(shop, orderId)).toMatchObject({ receipt_document_id: receipt.id, receipt_error: null });
  });

  it('R: the backfill gives a paid order without a receipt and without a job its job, once', async () => {
    const orderId = await placeOrder(shop);
    // As the old build left it: paid, no job, no receipt.
    await handlePaymentEvent({ ...shop.deps, emit: async () => [] }, paid(shop, orderId));
    expect(await receiptJobs(shop, orderId)).toEqual([]);

    await runJobBackfills(env.appDb, shop.clock.now);
    await runJobBackfills(env.appDb, shop.clock.now);
    const jobs = await receiptJobs(shop, orderId);
    expect(jobs).toHaveLength(1);
    expect(await runJobNow(group(), shop.company, jobs[0].id, worker(shop))).toMatchObject({ outcome: 'done' });
    expect(await receiptsOf(shop, orderId)).toHaveLength(1);
    // A paid order with its receipt gets nothing more.
    await runJobBackfills(env.appDb, shop.clock.now);
    expect((await receiptJobs(shop, orderId))[0]).toMatchObject({ id: jobs[0].id, status: 'done' });
  });

  it('E: a repeated delivery on a paid order writes no second job and issues nothing more', async () => {
    const orderId = await placeOrder(shop);
    const event = paid(shop, orderId);
    const first = await handlePaymentEvent(shop.deps, event);
    await runJobNow(group(), shop.company, first.jobIds[0], worker(shop));
    expect(await handlePaymentEvent(shop.deps, event)).toMatchObject({ status: 'paid', duplicate: true, jobIds: [] });
    expect(await handlePaymentEvent(shop.deps, paid(shop, orderId))).toMatchObject({ status: 'paid', duplicate: false, jobIds: [] });
    expect(await receiptJobs(shop, orderId)).toHaveLength(1);
    expect(await receiptsOf(shop, orderId)).toHaveLength(1);
  });

  it('E: a receipt whose total disagrees with the order is dead at once, and says why where the owner looks', async () => {
    const orderId = await placeOrder(shop, { netOrGross: 'net' });
    // The company changed to section 19 after the net order was priced with VAT: the receipt cannot add up.
    await initBooksCompany(scopeOf(shop), { taxStatus: 'small_business', senderBlock: syntheticSender(), counters: [] });
    const { jobIds } = await handlePaymentEvent(shop.deps, paid(shop, orderId));
    expect(await runJobNow(group(), shop.company, jobIds[0], worker(shop))).toMatchObject({ outcome: 'dead' });
    expect((await receiptJobs(shop, orderId))[0]).toMatchObject({ status: 'dead', last_error: 'TOTALS_MISMATCH' });
    expect(await payment(shop, orderId)).toMatchObject({ status: 'paid', receipt_document_id: null, receipt_error: 'TOTALS_MISMATCH' });
    expect(await receiptsOf(shop, orderId)).toEqual([]);
  });

  it('E: a job on a payment that is no longer paid is done, with no receipt and no alarm', async () => {
    const orderId = await placeOrder(shop);
    const { jobIds } = await handlePaymentEvent(shop.deps, paid(shop, orderId));
    // Refunded before the job came round (021's guard allows paid to refunded).
    await env.ownerDb
      .updateTable('order_payment')
      .set({ status: 'refunded', refund_id: `re_${randomUUID()}`, updated_at: new Date() })
      .where('tenant_id', '=', shop.company)
      .where('order_id', '=', orderId)
      .execute();
    expect(await runJobNow(group(), shop.company, jobIds[0], worker(shop))).toMatchObject({ outcome: 'done' });
    expect(await receiptsOf(shop, orderId)).toEqual([]);
    expect((await payment(shop, orderId)).receipt_error).toBeNull();
  });

  it('E: a link that finds the receipt already linked writes nothing and announces nothing', async () => {
    const orderId = await placeOrder(shop);
    await handlePaymentEvent(shop.deps, paid(shop, orderId));
    // Another attempt links the receipt between this one's issue and its link.
    const racing: PaymentDeps = {
      ...shop.deps,
      receipt: async (id) => {
        const issued = await shop.deps.receipt(id);
        await env.appDb
          .updateTable('order_payment')
          .set({ receipt_document_id: issued.documentId, updated_at: new Date() })
          .where('tenant_id', '=', shop.company)
          .where('order_id', '=', id)
          .execute();
        return issued;
      },
    };
    const before = shop.emitted.length;
    const attempt = await issueReceipt(racing, shop.company, orderId);
    expect(attempt).toMatchObject({ outcome: 'linked' });
    expect(shop.emitted.slice(before)).toEqual([]);
    // Asked again, the receipt is simply there.
    expect(await issueReceipt(shop.deps, shop.company, orderId)).toMatchObject({ outcome: 'linked', documentId: attempt.outcome === 'linked' ? attempt.documentId : '' });
    expect(shop.emitted.slice(before)).toEqual([]);
  });

  it('two companies in one group: each job issues only its own company receipt', async () => {
    const other = await newShop();
    const mine = await placeOrder(shop);
    const theirs = await placeOrder(other);
    const a = await handlePaymentEvent(shop.deps, paid(shop, mine));
    const b = await handlePaymentEvent(other.deps, paid(other, theirs));

    expect(await runJobNow(group(), shop.company, a.jobIds[0], worker(shop, other))).toMatchObject({ outcome: 'done' });
    expect(await receiptsOf(shop, mine)).toHaveLength(1);
    // The other company's order is untouched by this company's job, and its job still waits.
    expect(await receiptsOf(other, theirs)).toEqual([]);
    expect((await receiptJobs(other, theirs))[0]).toMatchObject({ status: 'pending' });
    // A job named under the wrong company is not found: the claim filters on the company too.
    expect(await runJobNow(group(), shop.company, b.jobIds[0], worker(shop, other))).toBeNull();

    expect(await runJobNow(group(), other.company, b.jobIds[0], worker(shop, other))).toMatchObject({ outcome: 'done' });
    const [theirReceipt] = await receiptsOf(other, theirs);
    expect(theirReceipt).toMatchObject({ status: 'issued' });
    expect(await receiptsOf(shop, theirs)).toEqual([]);
  });
});
