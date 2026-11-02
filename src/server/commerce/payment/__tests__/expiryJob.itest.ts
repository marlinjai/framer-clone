// src/server/commerce/payment/__tests__/expiryJob.itest.ts
//
// The expiry job (docs/plans/2026-11-02-shop-backbone.md, slice B3) against real Postgres, as the app role, through the
// real registry: the order writes the job, the worker's claim runs it, and the payment state machine decides under the
// row lock. Test names follow the stateful flow standard: F forward, B backtrack, R resume, E re-entry. Every race below
// is forced: another transaction holds the payment row until each caller is seen waiting on it.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booksScope } from '@/server/books/scope';
import {
  FakeContactBook,
  FakeDirectory,
  initCompany,
  openBooksEnv,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';
import { JOB_BACKFILLS, runJobBackfills } from '../../jobs/backfills';
import { claimJob, requeueJob } from '../../jobs/claim';
import { runNextJob } from '../../jobs/run';
import { JOB_LEASE_MS } from '../../jobs/types';
import { createOrder } from '../../order/createOrder';
import { catalogRepository } from '../../repository/catalog';
import { pricingRepository } from '../../repository/pricing';
import type { BuyerInput } from '../buyer';
import { handlePaymentEvent, sweepExpiredPayments, type PaymentDeps } from '../payments';
import { demoProvider, type PaymentEvent, type PaymentProvider } from '../provider';
import { ensureReceipt } from '../receipt';

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
const WINDOW = 30 * MINUTE;
const T0 = new Date('2026-10-26T09:30:00.000Z');

let env: BooksEnv;
let shop: Shop;
const clock = { now: T0 };
const after = (ms: number) => new Date(T0.getTime() + ms);

interface Shop {
  company: string;
  refunds: string[];
  deps: PaymentDeps;
}

async function newShop(opts: { books?: boolean } = {}): Promise<Shop> {
  const company = randomUUID();
  const dir = new FakeDirectory();
  const contacts = new FakeContactBook(dir);
  const scope = booksScope(env.appDb, env.tgId, company, { recipients: dir });
  if (opts.books !== false) await initCompany(scope, { taxStatus: 'regular', invoiceNext: 1000 });
  const refunds: string[] = [];
  const provider: PaymentProvider = {
    ...demoProvider,
    async refund(args) {
      refunds.push(args.providerPaymentId);
      return demoProvider.refund(args);
    },
  };
  return {
    company,
    refunds,
    deps: {
      db: env.appDb,
      tgId: env.tgId,
      provider: () => provider,
      receipt: (orderId) => ensureReceipt(scope, contacts, orderId, { now: clock.now }),
      now: () => clock.now,
    },
  };
}

beforeAll(async () => {
  env = await openBooksEnv('expiry-job');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

beforeEach(async () => {
  clock.now = T0;
  // Each test owns the group's queue: nothing an earlier test left pending can be claimed or backfilled here.
  await env.ownerDb.deleteFrom('commerce_job').execute();
  await env.ownerDb.updateTable('order_payment').set({ status: 'cancelled', closed_at: T0 }).where('status', '=', 'pending').execute();
  shop = await newShop();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function stockedRing(stock: number, company = shop.company) {
  const db = env.ownerDb;
  const product = await catalogRepository.createProduct(db, {
    tenantId: company,
    title: 'Ring',
    handle: `ring-${randomUUID().slice(0, 8)}`,
    status: 'published',
  });
  const sku = `RING-${randomUUID()}`;
  const variant = await catalogRepository.addVariant(db, { tenantId: company, productId: product.id, sku, title: 'Silber' });
  const set = await pricingRepository.createPriceSet(db, { tenantId: company, variantId: variant.id });
  await pricingRepository.addPrice(db, { tenantId: company, priceSetId: set.id, currency: 'EUR', amount: 4900 });
  const item = randomUUID();
  const location = randomUUID();
  await db.insertInto('inventory_item').values({ id: item, sku, updated_at: new Date() }).execute();
  await db.insertInto('stock_location').values({ id: location, name: `WH-${location}`, updated_at: new Date() }).execute();
  await db
    .insertInto('inventory_level')
    .values({ id: randomUUID(), inventory_item_id: item, location_id: location, stocked_quantity: stock, reserved_quantity: 0, updated_at: new Date() })
    .execute();
  return { variantId: variant.id, item, location };
}

type Ring = Awaited<ReturnType<typeof stockedRing>>;

function cart(ring: Ring, company: string, requestId: string, quantity = 1) {
  return {
    tenantId: company,
    siteId: 'site-shop',
    requestId,
    currency: 'EUR',
    taxRegion: 'DE',
    netOrGross: 'gross' as const,
    now: T0,
    lines: [
      {
        inventoryItemId: ring.item,
        variantId: ring.variantId,
        quantity,
        locationId: ring.location,
        variantRef: ring.variantId,
        variantRefSource: 'owned' as const,
      },
    ],
    payment: { provider: 'demo' as const, buyer: BUYER as never },
  };
}

async function placeOrder(ring: Ring, company = shop.company, quantity = 1): Promise<string> {
  const result = await createOrder(env.appDb, env.tgId, cart(ring, company, `rq-${randomUUID()}`, quantity));
  if (!result.ok) throw new Error('the order was short');
  return result.orderId;
}

const worker = () => ({ now: () => clock.now });
const runJob = () => runNextJob(env.appDb, env.tgId, worker());

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

function expiryOf(orderId: string): PaymentEvent {
  return event(orderId, 'checkout_expired', { eventId: `expiry:${orderId}`, providerPaymentId: undefined });
}

const pay = (orderId: string) => handlePaymentEvent(shop.deps, event(orderId, 'payment_succeeded'));

async function payment(orderId: string) {
  return env.ownerDb.selectFrom('order_payment').selectAll().where('order_id', '=', orderId).executeTakeFirstOrThrow();
}

async function jobsOf(orderId: string) {
  return env.ownerDb.selectFrom('commerce_job').selectAll().where('dedupe_key', '=', `expiry:${orderId}`).execute();
}

async function jobOf(orderId: string) {
  const [job, ...rest] = await jobsOf(orderId);
  expect(rest).toEqual([]);
  return job;
}

async function reserved(item: string): Promise<number> {
  const row = await env.ownerDb
    .selectFrom('inventory_level')
    .select('reserved_quantity')
    .where('inventory_item_id', '=', item)
    .executeTakeFirstOrThrow();
  return row.reserved_quantity;
}

function setReserved(item: string, quantity: number) {
  return env.ownerDb.updateTable('inventory_level').set({ reserved_quantity: quantity }).where('inventory_item_id', '=', item).execute();
}

/** What the append-only record and the stock ledger hold for an order. */
async function ledger(orderId: string) {
  const events = await env.ownerDb.selectFrom('payment_event').select('event_id').where('order_id', '=', orderId).execute();
  const releases = await env.ownerDb
    .selectFrom('stock_movement')
    .select('quantity')
    .where('movement_type', '=', 'release')
    .where('ref_id', '=', orderId)
    .execute();
  return { expiry: events.some((e) => e.event_id === `expiry:${orderId}`), releases: releases.length };
}

/**
 * Start `calls` one after the other while another transaction holds the payment row, each only once the one before
 * waits on it, so each has passed any read of its own and they reach the row in this order. `whileHeld` then changes
 * the row in that transaction, and the callers go on from what it committed.
 */
async function queueOnPaymentRow<T>(
  orderId: string,
  calls: Array<() => Promise<T>>,
  whileHeld?: (trx: Parameters<Parameters<ReturnType<typeof env.ownerDb.transaction>['execute']>[0]>[0]) => Promise<unknown>,
): Promise<T[]> {
  const started: Array<Promise<T>> = [];
  await env.ownerDb.transaction().execute(async (trx) => {
    await trx.selectFrom('order_payment').select('order_id').where('order_id', '=', orderId).forUpdate().execute();
    for (const call of calls) {
      started.push(call());
      const waiting = started.length;
      await vi.waitFor(
        async () => {
          const blocked = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted
               AND (transactionid = pg_current_xact_id()::xid
                    OR (locktype = 'tuple' AND relation = to_regclass(${`"${env.schema}".order_payment`})))
          `.execute(trx);
          expect(blocked.rows[0].n).toBe(waiting);
        },
        { timeout: 10_000, interval: 25 },
      );
    }
    await whileHeld?.(trx);
  });
  return Promise.all(started);
}

describe('F: forward', () => {
  it('the order writes one job due when the hold ends, and it leaves the stock alone until then', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);

    expect(await jobOf(orderId)).toMatchObject({
      tenant_id: shop.company,
      kind: 'payment_expiry',
      event_type: 'order.placed',
      payload: { orderId },
      status: 'pending',
      run_at: after(WINDOW),
      cycle_started_at: T0,
    });
    expect((await payment(orderId)).expires_at).toEqual(after(WINDOW));

    clock.now = after(WINDOW - 1);
    expect(await runJob()).toBeNull();
    expect((await jobOf(orderId)).attempts).toBe(0);
    expect(await reserved(ring.item)).toBe(1);
  });

  it('the window passes: the job closes the payment, gives the stock back and records the expiry once', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ kind: 'payment_expiry', outcome: 'done' });

    expect(await payment(orderId)).toMatchObject({ status: 'expired', closed_at: after(WINDOW) });
    expect(await reserved(ring.item)).toBe(0);
    expect(await ledger(orderId)).toEqual({ expiry: true, releases: 1 });
    expect((await jobOf(orderId)).status).toBe('done');
    expect(await runJob()).toBeNull();
  });
});

describe('B: backtrack', () => {
  it('a rolled-back order leaves no job: a shortage writes neither', async () => {
    const ring = await stockedRing(1);
    const before = (await env.ownerDb.selectFrom('commerce_job').select('id').execute()).length;

    const result = await createOrder(env.appDb, env.tgId, cart(ring, shop.company, `rq-${randomUUID()}`, 2));

    expect(result.ok).toBe(false);
    expect(await env.ownerDb.selectFrom('commerce_job').select('id').execute()).toHaveLength(before);
    expect(await reserved(ring.item)).toBe(0);
  });

  it('a job that cannot be written rolls back its order: no hold can exist without its job', async () => {
    const ring = await stockedRing(2);
    const requestId = `rq-${randomUUID()}`;
    const table = sql.id(env.schema, 'commerce_job');
    await sql`ALTER TABLE ${table} ADD CONSTRAINT "no_jobs" CHECK (false) NOT VALID`.execute(env.ownerDb);
    try {
      await expect(createOrder(env.appDb, env.tgId, cart(ring, shop.company, requestId))).rejects.toThrow(/no_jobs/);
    } finally {
      await sql`ALTER TABLE ${table} DROP CONSTRAINT "no_jobs"`.execute(env.ownerDb);
    }
    expect(await env.ownerDb.selectFrom('order').select('id').where('request_id', '=', requestId).execute()).toEqual([]);
    expect(await reserved(ring.item)).toBe(0);
  });

  it('the same order placed twice writes one job, and an order without a payment writes none', async () => {
    const ring = await stockedRing(3);
    const requestId = `rq-${randomUUID()}`;
    const first = await createOrder(env.appDb, env.tgId, cart(ring, shop.company, requestId));
    const again = await createOrder(env.appDb, env.tgId, cart(ring, shop.company, requestId));
    if (!first.ok || !again.ok) throw new Error('the order was short');
    expect(again.orderId).toBe(first.orderId);
    expect(await jobsOf(first.orderId)).toHaveLength(1);

    const unpaid = await createOrder(env.appDb, env.tgId, { ...cart(ring, shop.company, `rq-${randomUUID()}`), payment: undefined });
    if (!unpaid.ok) throw new Error('the order was short');
    expect(await jobsOf(unpaid.orderId)).toEqual([]);
  });

  it('paid before the window ends: the job writes nothing, keeps the stock and issues no receipt of its own', async () => {
    shop = await newShop({ books: false });
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(10 * MINUTE);
    await pay(orderId);
    const paid = await payment(orderId);
    expect(paid).toMatchObject({ status: 'paid', receipt_error: expect.any(String) });
    const receiptOf = vi.fn();
    shop.deps.receipt = receiptOf;

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ outcome: 'done' });

    expect(await payment(orderId)).toEqual(paid);
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 0 });
    expect(await reserved(ring.item)).toBe(1);
    expect(receiptOf).not.toHaveBeenCalled();
  });

  it('a pay reaching the row first: the job waiting behind it writes no false expiry on the paid order', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW);

    await queueOnPaymentRow<unknown>(orderId, [() => pay(orderId), () => runJob()]);

    expect(await payment(orderId)).toMatchObject({ status: 'paid', closed_at: null });
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 0 });
    expect(await reserved(ring.item)).toBe(1);
    expect((await jobOf(orderId)).status).toBe('done');
    expect(shop.refunds).toEqual([]);
  });

  it('a pay committed while the job waits on the row: the status is read under the lock, not before it', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW);

    await queueOnPaymentRow<unknown>(orderId, [() => runJob()], (trx) =>
      trx
        .updateTable('order_payment')
        .set({ status: 'paid', paid_at: clock.now, version: 1, updated_at: clock.now })
        .where('order_id', '=', orderId)
        .execute(),
    );

    expect((await payment(orderId)).status).toBe('paid');
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 0 });
    expect(await reserved(ring.item)).toBe(1);
  });

  it('a pay reaching the row first: a sweep waiting behind it writes no false expiry either', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW + 1);

    const [, swept] = await queueOnPaymentRow<unknown>(orderId, [
      () => pay(orderId),
      () => sweepExpiredPayments(shop.deps, shop.company),
    ]);

    expect(swept).toEqual([]);
    expect((await payment(orderId)).status).toBe('paid');
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 0 });
  });

  it('the job reaching the row first: the pay behind it takes the late path and ends paid with its stock', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW);

    await queueOnPaymentRow<unknown>(orderId, [() => runJob(), () => pay(orderId)]);

    expect((await payment(orderId)).status).toBe('paid');
    expect(await ledger(orderId)).toEqual({ expiry: true, releases: 1 });
    expect(await reserved(ring.item)).toBe(1);
    expect(shop.refunds).toEqual([]);
  });

  it('requireDue on a payment that is paid, closed or not due records nothing and changes nothing', async () => {
    const ring = await stockedRing(5);
    const open = await placeOrder(ring);
    const paid = await placeOrder(ring);
    await pay(paid);
    const declined = await placeOrder(ring);
    await handlePaymentEvent(shop.deps, event(declined, 'payment_failed', { failureCode: 'card_declined' }));

    for (const orderId of [open, paid, declined]) {
      const before = { row: await payment(orderId), ledger: await ledger(orderId) };
      const outcome = await handlePaymentEvent(shop.deps, { ...expiryOf(orderId), requireDue: true });
      expect(outcome).toMatchObject({ duplicate: false, status: before.row.status });
      expect(outcome.notDue).toEqual({ expiresAt: orderId === open ? after(WINDOW) : null });
      expect(await payment(orderId)).toEqual(before.row);
      expect(await ledger(orderId)).toEqual(before.ledger);
    }
  });

  it("a provider's own expiry report needs no date: it closes a payment before our window ends", async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    expect((await handlePaymentEvent(shop.deps, event(orderId, 'checkout_expired'))).status).toBe('expired');
    expect(await reserved(ring.item)).toBe(0);

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ outcome: 'done' });
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 1 });
  });
});

describe('R: resume', () => {
  /** An order the old build placed: its payment exists, and no job does. */
  async function placedByTheOldBuild(ring: Ring): Promise<string> {
    const orderId = await placeOrder(ring);
    await env.ownerDb.deleteFrom('commerce_job').where('dedupe_key', '=', `expiry:${orderId}`).execute();
    return orderId;
  }

  it('the backfill gives an order of the old build its job, as the app role, and running it twice writes one', async () => {
    const ring = await stockedRing(2);
    const orderId = await placedByTheOldBuild(ring);
    const at = after(MINUTE);

    await runJobBackfills(env.appDb, at);
    await runJobBackfills(env.appDb, at);

    const job = await jobOf(orderId);
    expect(job).toMatchObject({
      tenant_id: shop.company,
      kind: 'payment_expiry',
      event_type: null,
      payload: { orderId },
      status: 'pending',
      run_at: after(WINDOW),
      cycle_started_at: at,
    });
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ outcome: 'done' });
    expect((await payment(orderId)).status).toBe('expired');
    expect(await reserved(ring.item)).toBe(0);
  });

  it('the backfill picks up a hold already past its window, and leaves anything not pending alone', async () => {
    const ring = await stockedRing(5);
    const overdue = await placedByTheOldBuild(ring);
    const paid = await placedByTheOldBuild(ring);
    await pay(paid);
    const declined = await placedByTheOldBuild(ring);
    await handlePaymentEvent(shop.deps, event(declined, 'payment_failed'));

    clock.now = after(WINDOW + DAY);
    await runJobBackfills(env.appDb, clock.now);

    expect(await jobsOf(paid)).toEqual([]);
    expect(await jobsOf(declined)).toEqual([]);
    expect(await runJob()).toMatchObject({ outcome: 'done' });
    expect((await payment(overdue)).status).toBe('expired');
  });

  it('the backfill keeps a job that exists, and never brings back a finished one', async () => {
    expect(JOB_BACKFILLS.map((backfill) => backfill.name)).toEqual(['payment_expiry']);
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const written = await jobOf(orderId);

    await runJobBackfills(env.appDb, after(MINUTE));
    expect(await jobOf(orderId)).toEqual(written);

    clock.now = after(WINDOW);
    await runJob();
    const finished = await jobOf(orderId);
    await runJobBackfills(env.appDb, after(WINDOW + MINUTE));
    expect(await jobOf(orderId)).toEqual(finished);
  });

  it('a failing job keeps the stock held and retries on its backoff, then closes once the cause is gone', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW);
    // The stock level no longer agrees with the hold, so its release is refused.
    await setReserved(ring.item, 0);

    expect(await runJob()).toMatchObject({ outcome: 'retry' });
    expect((await payment(orderId)).status).toBe('pending');
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 0 });
    expect(await jobOf(orderId)).toMatchObject({ status: 'pending', attempts: 1, run_at: after(WINDOW + MINUTE) });

    clock.now = after(WINDOW + 30_000);
    expect(await runJob()).toBeNull();

    await setReserved(ring.item, 1);
    clock.now = after(WINDOW + MINUTE);
    expect(await runJob()).toMatchObject({ outcome: 'done' });
    expect((await payment(orderId)).status).toBe('expired');
    expect(await reserved(ring.item)).toBe(0);
  });

  it('a job failing for 3 days is dead for a person to see, with the stock still held, and a requeue finishes it', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    await setReserved(ring.item, 0);

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ outcome: 'retry' });
    clock.now = after(WINDOW + 3 * DAY);
    await env.ownerDb.updateTable('commerce_job').set({ cycle_started_at: T0 }).where('dedupe_key', '=', `expiry:${orderId}`).execute();
    expect(await runJob()).toMatchObject({ outcome: 'dead' });

    expect(await jobOf(orderId)).toMatchObject({ status: 'dead', last_error: expect.stringMatching(/\S/) });
    expect((await payment(orderId)).status).toBe('pending');

    await setReserved(ring.item, 1);
    const job = await jobOf(orderId);
    expect(await requeueJob(env.appDb, shop.company, job.id, clock.now)).toBe(true);
    expect(await runJob()).toMatchObject({ outcome: 'done' });
    expect((await payment(orderId)).status).toBe('expired');
  });

  it('a worker that died holding the job: the next claim after the lease closes the payment, once', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW);
    expect(await claimJob(env.appDb, { kinds: ['payment_expiry'], now: clock.now })).not.toBeNull();

    expect(await runJob()).toBeNull();
    clock.now = after(WINDOW + JOB_LEASE_MS);
    expect(await runJob()).toMatchObject({ outcome: 'done' });

    expect((await payment(orderId)).status).toBe('expired');
    expect(await ledger(orderId)).toEqual({ expiry: true, releases: 1 });
  });

  it('a date that moved: the job writes nothing and comes back at the new date', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const moved = after(WINDOW + 20 * MINUTE);
    await env.appDb.updateTable('order_payment').set({ expires_at: moved }).where('order_id', '=', orderId).execute();

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ outcome: 'rerun' });
    expect(await jobOf(orderId)).toMatchObject({ status: 'pending', run_at: moved, attempts: 0 });
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 0 });
    expect(await reserved(ring.item)).toBe(1);

    clock.now = moved;
    expect(await runJob()).toMatchObject({ outcome: 'done' });
    expect((await payment(orderId)).status).toBe('expired');
  });

  it('a date moved while the job waits on the row: the date is read under the lock, not before it', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const moved = after(WINDOW + 20 * MINUTE);
    clock.now = after(WINDOW);

    const [result] = await queueOnPaymentRow(orderId, [() => runJob()], (trx) =>
      trx.updateTable('order_payment').set({ expires_at: moved }).where('order_id', '=', orderId).execute(),
    );

    expect(result).toMatchObject({ outcome: 'rerun' });
    expect((await payment(orderId)).status).toBe('pending');
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 0 });
    expect((await jobOf(orderId)).run_at).toEqual(moved);
  });

  it('a date moved while a sweep waits on the row: the sweep closes nothing either', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW + 1);

    const [swept] = await queueOnPaymentRow(orderId, [() => sweepExpiredPayments(shop.deps, shop.company)], (trx) =>
      trx.updateTable('order_payment').set({ expires_at: after(WINDOW + 20 * MINUTE) }).where('order_id', '=', orderId).execute(),
    );

    expect(swept).toEqual([]);
    expect((await payment(orderId)).status).toBe('pending');
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 0 });
  });
});

describe('E: re-entry', () => {
  it('the old sweep and the job beside it close a payment once, whichever comes first', async () => {
    const ring = await stockedRing(3);
    const swept = await placeOrder(ring);
    const jobbed = await placeOrder(ring);
    clock.now = after(WINDOW + 1);

    expect(await sweepExpiredPayments(shop.deps, shop.company, { orderId: swept })).toEqual([swept]);
    expect(await runJob()).toMatchObject({ outcome: 'done' });
    expect(await runJob()).toMatchObject({ outcome: 'done' });
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([]);

    expect(await ledger(swept)).toEqual({ expiry: true, releases: 1 });
    expect(await ledger(jobbed)).toEqual({ expiry: true, releases: 1 });
    expect(await reserved(ring.item)).toBe(0);
  });

  it('the job and the sweep racing on one row: one release, one event', async () => {
    const ring = await stockedRing(3);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW + 1);

    await queueOnPaymentRow<unknown>(orderId, [() => runJob(), () => sweepExpiredPayments(shop.deps, shop.company)]);

    expect((await payment(orderId)).status).toBe('expired');
    expect(await ledger(orderId)).toEqual({ expiry: true, releases: 1 });
  });

  it('a late success after the job closed it, with the stock still there: paid with a receipt, and the job stays done', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW);
    await runJob();

    expect(await pay(orderId)).toMatchObject({ status: 'paid', receiptError: null });

    expect(await payment(orderId)).toMatchObject({ status: 'paid', closed_at: null });
    expect(await reserved(ring.item)).toBe(1);
    expect(shop.refunds).toEqual([]);
    expect((await jobOf(orderId)).status).toBe('done');
    expect(await runJob()).toBeNull();
  });

  it('a late success after the job closed it, with the stock gone: refunded, and the order stays closed', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW);
    await runJob();
    await placeOrder(ring);

    expect(await pay(orderId)).toMatchObject({ status: 'refunded' });

    expect(shop.refunds).toEqual([`demo_pi_${orderId}`]);
    expect(await reserved(ring.item)).toBe(1);
  });

  it('a payment already closed: the job is a no-op that gives nothing back twice', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    await handlePaymentEvent(shop.deps, event(orderId, 'payment_failed', { failureCode: 'card_declined' }));
    const closed = await payment(orderId);
    expect(await reserved(ring.item)).toBe(0);

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ outcome: 'done' });

    expect(await payment(orderId)).toEqual(closed);
    expect(await ledger(orderId)).toEqual({ expiry: false, releases: 1 });
    expect(await reserved(ring.item)).toBe(0);
  });

  it('a repeated run after the close changes nothing: the job can always run twice', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    clock.now = after(WINDOW);
    await runJob();
    const closed = await payment(orderId);
    const { id } = await jobOf(orderId);

    await env.ownerDb.updateTable('commerce_job').set({ status: 'pending', finished_at: null, run_at: clock.now }).where('id', '=', id).execute();
    expect(await runJob()).toMatchObject({ outcome: 'done' });

    expect(await payment(orderId)).toEqual(closed);
    expect(await ledger(orderId)).toEqual({ expiry: true, releases: 1 });
  });

  it('a job naming no payment is refused for a person, and touches nothing', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    const { id } = await jobOf(orderId);

    await env.ownerDb.updateTable('commerce_job').set({ payload: sql`'{"orderId": "no-such-order"}'::jsonb` }).where('id', '=', id).execute();
    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ outcome: 'dead' });
    expect(await jobOf(orderId)).toMatchObject({ status: 'dead', last_error: 'unknown_payment' });
    expect(await reserved(ring.item)).toBe(1);
  });
});

describe('two companies in one tenant group', () => {
  it("each job closes only its own company's payment, and the other's stock stays held", async () => {
    const ring = await stockedRing(2);
    const mine = await placeOrder(ring);
    const other = await newShop();
    const theirRing = await stockedRing(2, other.company);
    clock.now = after(10 * MINUTE);
    const theirs = await createOrder(env.appDb, env.tgId, { ...cart(theirRing, other.company, `rq-${randomUUID()}`), now: clock.now });
    if (!theirs.ok) throw new Error('the order was short');

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ tenantId: shop.company, outcome: 'done' });
    expect(await runJob()).toBeNull();

    expect((await payment(mine)).status).toBe('expired');
    expect(await reserved(ring.item)).toBe(0);
    expect((await payment(theirs.orderId)).status).toBe('pending');
    expect(await reserved(theirRing.item)).toBe(1);
    expect((await jobOf(theirs.orderId)).status).toBe('pending');

    clock.now = after(WINDOW + 10 * MINUTE);
    expect(await runJob()).toMatchObject({ tenantId: other.company, outcome: 'done' });
    expect((await payment(theirs.orderId)).status).toBe('expired');
    expect(await reserved(theirRing.item)).toBe(0);
  });

  it("a job of one company naming another company's order is refused, and that order stays as it was", async () => {
    const ring = await stockedRing(2);
    const mine = await placeOrder(ring);
    const other = await newShop();
    const theirRing = await stockedRing(2, other.company);
    const theirs = await placeOrder(theirRing, other.company);
    const { id } = await jobOf(mine);
    await env.ownerDb.deleteFrom('commerce_job').where('dedupe_key', '=', `expiry:${theirs}`).execute();
    await env.ownerDb
      .updateTable('commerce_job')
      .set({ payload: sql`jsonb_build_object('orderId', ${theirs}::text)` })
      .where('id', '=', id)
      .execute();

    clock.now = after(WINDOW);
    expect(await runJob()).toMatchObject({ tenantId: shop.company, outcome: 'dead' });

    expect((await payment(theirs)).status).toBe('pending');
    expect(await reserved(theirRing.item)).toBe(1);
  });

  it('the backfill keeps each job with the company of its payment', async () => {
    const ring = await stockedRing(2);
    const mine = await placeOrder(ring);
    const other = await newShop();
    const theirs = await placeOrder(await stockedRing(2, other.company), other.company);
    await env.ownerDb.deleteFrom('commerce_job').execute();

    await runJobBackfills(env.appDb, T0);

    expect((await jobOf(mine)).tenant_id).toBe(shop.company);
    expect((await jobOf(theirs)).tenant_id).toBe(other.company);
  });
});
