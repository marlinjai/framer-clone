// src/server/commerce/payment/__tests__/checkoutSession.itest.ts
//
// The pinned Stripe checkout session (docs/plans/2026-11-02-shop-backbone.md, section 2.1 and slice B7) against real
// Postgres, as the app role, through the real Stripe HTTP client (`httpStripeApi`) and provider (`stripeProvider`). Only
// the network is fake: `StripeSandbox` below answers as Stripe's sandbox did in the proof run of 2026-11-23 (section
// 2.5): one idempotency key holds one request, a repeat of it replays the first answer (an error too, and the cached
// "open" even after the session expired), another request under it is refused with `idempotency_error`, a 429 is not
// stored, and `expires_at` must be at least 30 minutes after creation. Because the client is real, "the same request"
// is checked on the bytes it sends.
//
// Test names follow the stateful flow standard: F forward, B backtrack, R resume, E re-entry.
// All data is synthetic; the Stripe key is built at run time.

import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booksScope } from '@/server/books/scope';
import { FakeContactBook, FakeDirectory, initCompany, openBooksEnv, rejectionCode, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { toJsonb } from '@/server/books/snapshots';
import { emitCommerceEvent } from '../../jobs/emit';
import { runNextJob } from '../../jobs/run';
import { createOrder } from '../../order/createOrder';
import { catalogRepository } from '../../repository/catalog';
import { pricingRepository } from '../../repository/pricing';
import type { BuyerInput } from '../buyer';
import {
  CREATE_MARGIN_MS,
  openCheckoutSession,
  STRIPE_CALL_TIMEOUT_MS,
  pinCheckoutSession,
  SESSION_EVENT,
  type CheckoutOrder,
  type PinnedSession,
} from '../checkoutSession';
import { PAYMENT_EXPIRY_KIND, paymentExpiryKind } from '../expiryJob';
import { handlePaymentEvent, sweepExpiredPayments, type PaymentDeps } from '../payments';
import { demoProvider, type PaymentEvent } from '../provider';
import { ensureReceipt } from '../receipt';
import { httpStripeApi } from '../stripe/client';
import { stripeProvider } from '../stripe/connect';

const BUYER: BuyerInput = {
  kind: 'person',
  name: 'Alex Example',
  email: 'alex@example.com',
  addressLine1: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
};
const OTHER_BUYER: BuyerInput = { ...BUYER, name: 'Sam Other', email: 'sam@example.com' };

const MINUTE = 60_000;
const T0 = new Date('2026-11-23T09:30:00.000Z');
const RETURN_URL = 'https://shop.example/cart';

let env: BooksEnv;
const clock = { now: T0 };
const at = (ms: number) => new Date(T0.getTime() + ms);

interface StoredAnswer {
  body: string;
  status: number;
  json: unknown;
}

interface SandboxSession {
  id: string;
  /** The connected account it lives on (the Stripe-Account header of its create). */
  account: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  url: string | null;
  amount_total: number;
  currency: string;
  payment_intent: string | null;
}

interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

/** Stripe's sandbox as the proof run found it, at the fetch level. */
class StripeSandbox {
  readonly requests: SeenRequest[] = [];
  readonly sessions = new Map<string, SandboxSession>();
  readonly byKey = new Map<string, StoredAnswer>();
  /**
   * What the next create meets: `lost` Stripe makes and stores the session but the answer never arrives; `unreachable`
   * nothing reaches Stripe; `refuse` an answered 400 (stored); `fail500` an answered 500 (stored, as Stripe documents);
   * `rateLimit` a 429 (not stored); `inUse` a 409 for a key in use by a concurrent request (not stored).
   */
  nextCreate: Array<'lost' | 'unreachable' | 'refuse' | 'fail500' | 'rateLimit' | 'inUse'> = [];
  /** What the next retrieve meets. */
  nextRetrieve: Array<'unreachable' | 'gateway'> = [];
  /** What the next expire meets. */
  nextExpire: Array<'unreachable'> = [];
  /** What the next account lookup meets. */
  nextAccount: Array<'fail500'> = [];
  /** Runs after Stripe made a session and before its answer reaches the caller: another click, a close, in between. */
  beforeCreateAnswer: Array<() => Promise<void>> = [];
  /** Runs before a retrieve is answered. */
  beforeRetrieveAnswer: Array<() => Promise<void>> = [];

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = { ...(init?.headers as Record<string, string>) };
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : String(init.body);
    this.requests.push({ method, path: url.pathname, headers, body, signal: init?.signal ?? undefined });
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') return this.create(headers, body ?? '');
    const retrieve = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && retrieve) return this.retrieve(headers['stripe-account'], decodeURIComponent(retrieve[1]));
    const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
    if (method === 'POST' && expire) return this.expireCall(headers['stripe-account'], decodeURIComponent(expire[1]));
    if (method === 'GET' && url.pathname.startsWith('/v1/accounts/')) {
      if (this.nextAccount.shift() === 'fail500') return stripeError(500, 'api_error', null);
      return Response.json({ id: url.pathname.split('/')[3], charges_enabled: true, details_submitted: true });
    }
    throw new Error(`the sandbox has no route for ${method} ${url.pathname}`);
  };

  creates(): SeenRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions');
  }

  retrieves(): SeenRequest[] {
    return this.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/v1/checkout/sessions/'));
  }

  expires(): SeenRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/expire'));
  }

  /** The session Stripe made for an order (its metadata is in the stored request). */
  only(): SandboxSession {
    const all = [...this.sessions.values()];
    expect(all).toHaveLength(1);
    return all[0];
  }

  private async create(headers: Record<string, string>, body: string): Promise<Response> {
    const key = headers['idempotency-key'];
    const mode = this.nextCreate.shift();
    if (mode === 'unreachable') throw new TypeError('fetch failed');
    if (mode === 'rateLimit') return stripeError(429, 'rate_limit_error', 'rate_limit');
    if (mode === 'inUse') return stripeError(409, 'idempotency_error', 'idempotency_key_in_use');
    const earlier = key ? this.byKey.get(key) : undefined;
    if (earlier) {
      if (earlier.body !== body) return stripeError(400, 'idempotency_error', null);
      return new Response(JSON.stringify(earlier.json), { status: earlier.status, headers: { 'idempotent-replayed': 'true' } });
    }
    let answer: StoredAnswer;
    const params = new URLSearchParams(body);
    const expiresAt = Number(params.get('expires_at'));
    if (mode === 'refuse') {
      answer = { body, status: 400, json: { error: { type: 'invalid_request_error', code: 'parameter_invalid', message: 'refused' } } };
    } else if (mode === 'fail500') {
      answer = { body, status: 500, json: { error: { type: 'api_error', message: 'An unknown error occurred' } } };
    } else if (expiresAt * 1000 - clock.now.getTime() < 30 * MINUTE) {
      answer = {
        body,
        status: 400,
        json: { error: { type: 'invalid_request_error', message: 'The `expires_at` timestamp must be at least 30 minutes from Checkout Session creation.' } },
      };
    } else {
      const id = `cs_test_${randomBytes(8).toString('hex')}`;
      const session: SandboxSession = {
        id,
        account: headers['stripe-account'],
        status: 'open',
        payment_status: 'unpaid',
        url: `https://checkout.stripe.test/c/pay/${id}`,
        amount_total: Number(params.get('line_items[0][price_data][unit_amount]')),
        currency: String(params.get('line_items[0][price_data][currency]')),
        payment_intent: null,
      };
      this.sessions.set(id, session);
      answer = { body, status: 200, json: { ...session } };
    }
    if (key) this.byKey.set(key, answer);
    if (mode === 'lost') throw new TypeError('fetch failed');
    const between = this.beforeCreateAnswer.shift();
    if (between) await between();
    return new Response(JSON.stringify(answer.json), { status: answer.status });
  }

  private async retrieve(account: string, id: string): Promise<Response> {
    const mode = this.nextRetrieve.shift();
    if (mode === 'unreachable') throw new TypeError('fetch failed');
    if (mode === 'gateway') return new Response('<html>Bad gateway</html>', { status: 502 });
    const between = this.beforeRetrieveAnswer.shift();
    if (between) await between();
    // A session lives on one account: asked on another, Stripe does not know it.
    const session = this.sessions.get(id);
    if (!session || session.account !== account) return stripeError(404, 'invalid_request_error', 'resource_missing');
    return Response.json(session);
  }

  private expireCall(account: string, id: string): Response {
    if (this.nextExpire.shift() === 'unreachable') throw new TypeError('fetch failed');
    const session = this.sessions.get(id);
    if (!session || session.account !== account) return stripeError(404, 'invalid_request_error', 'resource_missing');
    if (session.status !== 'open') return stripeError(400, 'invalid_request_error', 'checkout_session_not_open');
    this.expire(id);
    return Response.json(session);
  }

  pay(id: string): void {
    const session = this.sessions.get(id)!;
    Object.assign(session, { status: 'complete', payment_status: 'paid', url: null, payment_intent: `pi_${randomBytes(6).toString('hex')}` });
  }

  expire(id: string): void {
    Object.assign(this.sessions.get(id)!, { status: 'expired', url: null });
  }
}

function stripeError(status: number, type: string, code: string | null): Response {
  return new Response(JSON.stringify({ error: { type, ...(code ? { code } : {}), message: `${type} ${code ?? ''}` } }), { status });
}

interface Shop {
  company: string;
  accountId: string;
  sandbox: StripeSandbox;
  deps: PaymentDeps;
}

async function newShop(): Promise<Shop> {
  const company = randomUUID();
  const dir = new FakeDirectory();
  const contacts = new FakeContactBook(dir);
  const scope = booksScope(env.appDb, env.tgId, company, { recipients: dir });
  await initCompany(scope, { taxStatus: 'regular', invoiceNext: 1000 });
  const accountId = `acct_${randomBytes(8).toString('hex')}`;
  await env.ownerDb
    .insertInto('payment_account')
    .values({ tenant_id: company, provider: 'stripe', account_id: accountId, status: 'ready', charges_enabled: true, details_submitted: true, updated_at: T0 })
    .execute();
  const sandbox = new StripeSandbox();
  const config = { secretKey: `test_${randomBytes(12).toString('hex')}`, webhookSecret: 'unused', connectClientId: 'unused' };
  const stripe = stripeProvider(httpStripeApi(config, sandbox.fetch as typeof fetch), { db: env.appDb, tenantId: company, tenantGroupId: env.tgId });
  return {
    company,
    accountId,
    sandbox,
    deps: {
      db: env.appDb,
      tgId: env.tgId,
      provider: (id) => (id === 'demo' ? demoProvider : stripe),
      receipt: (orderId) => ensureReceipt(scope, contacts, orderId, { now: clock.now }),
      emit: (trx, e) => emitCommerceEvent(trx, e),
      now: () => clock.now,
    },
  };
}

let shop: Shop;

beforeAll(async () => {
  env = await openBooksEnv('checkout-session');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

beforeEach(async () => {
  clock.now = T0;
  // Each test owns the group's queue and its pending payments.
  await env.ownerDb.deleteFrom('commerce_job').execute();
  await env.ownerDb.updateTable('order_payment').set({ status: 'cancelled', closed_at: T0 }).where('status', '=', 'pending').execute();
  shop = await newShop();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function stockedRing(stock: number) {
  const db = env.ownerDb;
  const company = shop.company;
  const product = await catalogRepository.createProduct(db, { tenantId: company, title: 'Ring', handle: `ring-${randomUUID().slice(0, 8)}`, status: 'published' });
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

async function placeOrder(ring: Ring, provider: 'stripe' | 'demo' = 'stripe'): Promise<string> {
  const result = await createOrder(env.appDb, env.tgId, {
    tenantId: shop.company,
    siteId: 'site-shop',
    requestId: `rq-${randomUUID()}`,
    currency: 'EUR',
    taxRegion: 'DE',
    netOrGross: 'gross',
    now: clock.now,
    lines: [{ inventoryItemId: ring.item, variantId: ring.variantId, quantity: 1, locationId: ring.location, variantRef: ring.variantId, variantRefSource: 'owned' }],
    payment: { provider, buyer: BUYER as never },
  });
  if (!result.ok) throw new Error('the order was short');
  return result.orderId;
}

async function payment(orderId: string) {
  return env.ownerDb.selectFrom('order_payment').selectAll().where('order_id', '=', orderId).executeTakeFirstOrThrow();
}

async function reserved(item: string): Promise<number> {
  const row = await env.ownerDb.selectFrom('inventory_level').select('reserved_quantity').where('inventory_item_id', '=', item).executeTakeFirstOrThrow();
  return row.reserved_quantity;
}

async function eventIds(orderId: string): Promise<string[]> {
  const rows = await env.ownerDb.selectFrom('payment_event').select('event_id').where('order_id', '=', orderId).orderBy('event_id').execute();
  return rows.map((r) => r.event_id);
}

async function checkoutOrder(orderId: string): Promise<CheckoutOrder> {
  const row = await env.ownerDb
    .selectFrom('order_payment')
    .innerJoin('order', (join) => join.onRef('order.id', '=', 'order_payment.order_id').onRef('order.tenant_id', '=', 'order_payment.tenant_id'))
    .select(['order.order_number as orderNumber', 'order_payment.amount as amount', 'order_payment.currency_code as currency', 'order_payment.application_fee_amount as fee'])
    .where('order_payment.order_id', '=', orderId)
    .executeTakeFirstOrThrow();
  return { tenantId: shop.company, orderId, orderNumber: row.orderNumber, amount: row.amount, currency: row.currency, applicationFeeAmount: row.fee };
}

/** The account a new session is made on, as the route asks it (with the click's signal). */
const account = (signal?: AbortSignal) => () => shop.deps.provider('stripe').chargeableAccount!(signal);

/** A Pay click as the route makes it: pin (or read the pin), then open. */
async function click(orderId: string, buyer: BuyerInput = BUYER, returnUrl = RETURN_URL) {
  const pinned = await pinCheckoutSession(env.appDb, shop.company, orderId, buyer as never, returnUrl, clock.now, account());
  if (!pinned.ok) return { pinned };
  const answer = await openCheckoutSession(shop.deps, await checkoutOrder(orderId), pinned.pin, { now: clock.now });
  return { pinned, answer };
}

async function pinOf(orderId: string): Promise<PinnedSession> {
  const pinned = await pinCheckoutSession(env.appDb, shop.company, orderId, BUYER as never, RETURN_URL, clock.now, account());
  if (!pinned.ok) throw new Error(`no pin: ${pinned.reason}`);
  return pinned.pin;
}

function webhookEvent(orderId: string, type: PaymentEvent['type'], extra: Partial<PaymentEvent> = {}): PaymentEvent {
  return { provider: 'stripe', eventId: `evt_${randomBytes(6).toString('hex')}`, type, tenantId: shop.company, orderId, ...extra };
}

const worker = () => ({ now: () => clock.now, kinds: { [PAYMENT_EXPIRY_KIND]: paymentExpiryKind }, paymentDeps: () => shop.deps });
const runExpiryJob = () => runNextJob({ id: env.tgId, db: env.appDb }, worker());

async function expiryJob(orderId: string) {
  return env.ownerDb.selectFrom('commerce_job').selectAll().where('dedupe_key', '=', `expiry:${orderId}`).executeTakeFirstOrThrow();
}

describe('F: the first Pay click pins, creates, stores and redirects', () => {
  it('pins the end 45 minutes out, the return address and the buyer, moves the hold past it, and stores the session id', async () => {
    const ring = await stockedRing(2);
    const orderId = await placeOrder(ring);
    expect(await payment(orderId)).toMatchObject({ expires_at: at(30 * MINUTE), session_expires_at: null, provider_session_id: null });

    const { answer } = await click(orderId);
    const session = shop.sandbox.only();
    expect(answer).toEqual({ kind: 'redirect', url: session.url });
    expect(await payment(orderId)).toMatchObject({
      status: 'pending',
      session_expires_at: at(45 * MINUTE),
      expires_at: at(50 * MINUTE),
      session_return_url: RETURN_URL,
      provider_session_id: session.id,
      buyer: { email: BUYER.email },
    });
    const [create] = shop.sandbox.creates();
    expect(create.headers['idempotency-key']).toBe(`checkout:${orderId}`);
    expect(create.headers['stripe-account']).toBe(shop.accountId);
    expect(new URLSearchParams(create.body).get('expires_at')).toBe(String(at(45 * MINUTE).getTime() / 1000));
    expect(new URLSearchParams(create.body).get('customer_email')).toBe(BUYER.email);
  });

  it('the expiry job follows the moved hold: at the old end it reruns at the new one', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    clock.now = at(30 * MINUTE);
    await runExpiryJob();
    expect(await expiryJob(orderId)).toMatchObject({ status: 'pending', run_at: at(50 * MINUTE) });
    expect((await payment(orderId)).status).toBe('pending');
    expect(await reserved(ring.item)).toBe(1);
    expect(shop.sandbox.retrieves()).toHaveLength(0);
  });
});

describe('B: the buyer comes back', () => {
  it('back from Stripe five minutes later, from another page: the same session and page, read and not created again', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    const first = await click(orderId);
    clock.now = at(5 * MINUTE);
    const again = await click(orderId, BUYER, 'https://shop.example/other-page');
    expect(again.answer).toEqual(first.answer);
    expect(shop.sandbox.creates()).toHaveLength(1);
    expect(shop.sandbox.retrieves()).toHaveLength(1);
    expect((await payment(orderId)).session_return_url).toBe(RETURN_URL);
  });

  it('another buyer after the pin is refused, nothing changes and Stripe is not asked; the database refuses it too (BK018)', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    const before = await payment(orderId);
    const other = await click(orderId, OTHER_BUYER);
    expect(other.pinned).toEqual({ ok: false, reason: 'buyer_fixed' });
    expect(await payment(orderId)).toEqual(before);
    expect(shop.sandbox.requests).toHaveLength(1);
    const change = env.appDb.updateTable('order_payment').set({ buyer: toJsonb(OTHER_BUYER) }).where('order_id', '=', orderId).execute();
    expect(await rejectionCode(change)).toBe('BK018');
  });

  it('a declined attempt keeps the payment pending and its stock held while the session is open; the retry pays normally', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    clock.now = at(10 * MINUTE);
    const declined = await handlePaymentEvent(shop.deps, webhookEvent(orderId, 'payment_failed', { failureCode: 'insufficient_funds' }));
    expect(declined).toMatchObject({ status: 'pending', duplicate: false });
    expect(await payment(orderId)).toMatchObject({ status: 'pending', failure_code: 'insufficient_funds', closed_at: null });
    expect(await reserved(ring.item)).toBe(1);
    // A second decline on the same page is recorded too, and still closes nothing.
    await handlePaymentEvent(shop.deps, webhookEvent(orderId, 'payment_failed', { failureCode: 'generic_decline' }));
    expect(await payment(orderId)).toMatchObject({ status: 'pending', failure_code: 'generic_decline' });
    expect(await eventIds(orderId)).toHaveLength(2);

    clock.now = at(12 * MINUTE);
    const paid = await handlePaymentEvent(shop.deps, webhookEvent(orderId, 'payment_succeeded', { amount: 4900, currency: 'EUR', providerPaymentId: 'pi_good' }));
    expect(paid.status).toBe('paid');
    expect(await payment(orderId)).toMatchObject({ status: 'paid', failure_code: null, refund_id: null });
    expect(await reserved(ring.item)).toBe(1);
  });

  it('a decline delivered after the session ended still leaves a pinned payment pending; an unpinned or demo one closes at once', async () => {
    const ring = await stockedRing(3);
    const pinned = await placeOrder(ring);
    await click(pinned);
    const before = await payment(pinned);
    clock.now = at(46 * MINUTE);
    await handlePaymentEvent(shop.deps, webhookEvent(pinned, 'payment_failed', { failureCode: 'card_declined' }));
    // The decline is kept and counted as a write (version), the hold and the stock stay: the session's own end closes it.
    expect(await payment(pinned)).toMatchObject({ status: 'pending', failure_code: 'card_declined', closed_at: null, version: before.version + 1 });
    expect(await reserved(ring.item)).toBe(1);

    clock.now = T0;
    const unpinned = await placeOrder(ring);
    await handlePaymentEvent(shop.deps, webhookEvent(unpinned, 'payment_failed', { failureCode: 'card_declined' }));
    expect((await payment(unpinned)).status).toBe('failed');

    const demo = await placeOrder(ring, 'demo');
    await handlePaymentEvent(shop.deps, { ...webhookEvent(demo, 'payment_failed', { failureCode: 'card_declined' }), provider: 'demo' });
    expect((await payment(demo)).status).toBe('failed');
    expect(await reserved(ring.item)).toBe(1);
  });

  it('redelivery order: a decline processed after the session ended, then the success of a later attempt pays normally', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    // Stripe: attempt one declined, attempt two paid; the decline's delivery arrives late, after the session's end.
    clock.now = at(47 * MINUTE);
    await handlePaymentEvent(shop.deps, webhookEvent(orderId, 'payment_failed', { failureCode: 'insufficient_funds' }));
    expect((await payment(orderId)).status).toBe('pending');
    const paid = await handlePaymentEvent(shop.deps, webhookEvent(orderId, 'payment_succeeded', { amount: 4900, currency: 'EUR', providerPaymentId: 'pi_second' }));
    // Not the late path: no reservation again, no refund, the stock held all along.
    expect(paid.status).toBe('paid');
    expect(await payment(orderId)).toMatchObject({ status: 'paid', refund_id: null, closed_at: null, failure_code: null });
    expect(await reserved(ring.item)).toBe(1);
    expect(shop.sandbox.requests.filter((r) => r.path.startsWith('/v1/refunds'))).toEqual([]);
  });
});

describe('R: an answer lost between the pin and the store', () => {
  it('the retry sends the very same bytes under the same key, also five minutes later, and stores the session it gets back', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    shop.sandbox.nextCreate.push('lost');
    const lost = await click(orderId);
    expect(lost.answer).toEqual({ kind: 'unavailable' });
    expect(await payment(orderId)).toMatchObject({ status: 'pending', provider_session_id: null, session_expires_at: at(45 * MINUTE) });

    clock.now = at(5 * MINUTE);
    const retried = await openCheckoutSession(shop.deps, await checkoutOrder(orderId), await pinOf(orderId), { now: clock.now });
    const session = shop.sandbox.only();
    expect(retried).toEqual({ kind: 'redirect', url: session.url });
    const [first, second] = shop.sandbox.creates();
    expect(second.body).toBe(first.body);
    expect(second.headers).toEqual(first.headers);
    expect((await payment(orderId)).provider_session_id).toBe(session.id);
  });

  it('Stripe unreachable: nothing changes, the buyer may click again, and the next click creates', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    shop.sandbox.nextCreate.push('unreachable');
    expect((await click(orderId)).answer).toEqual({ kind: 'unavailable' });
    expect(shop.sandbox.sessions.size).toBe(0);
    clock.now = at(1 * MINUTE);
    expect((await click(orderId)).answer).toMatchObject({ kind: 'redirect' });
    expect(shop.sandbox.creates().map((c) => c.body)).toEqual([shop.sandbox.creates()[0].body, shop.sandbox.creates()[0].body]);
  });

  it('a 429 and a key in use are not stored by Stripe: the payment waits, and the next click goes through', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    shop.sandbox.nextCreate.push('rateLimit', 'inUse');
    expect((await click(orderId)).answer).toEqual({ kind: 'unavailable' });
    expect((await click(orderId)).answer).toEqual({ kind: 'unavailable' });
    expect((await payment(orderId)).status).toBe('pending');
    expect((await click(orderId)).answer).toMatchObject({ kind: 'redirect' });
  });

  it('past the margin the payment closes and its stock goes back, with no further create and no second session', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    shop.sandbox.nextCreate.push('lost');
    await click(orderId);
    // 45 minutes pinned: with 31 or fewer left, the stored end would be refused and a new key would open a second session;
    // the click's own wait for Stripe is added, so an answer still on its way lands before the margin.
    clock.now = new Date(at(45 * MINUTE).getTime() - CREATE_MARGIN_MS - STRIPE_CALL_TIMEOUT_MS);
    const answer = await openCheckoutSession(shop.deps, await checkoutOrder(orderId), await pinOf(orderId), { now: clock.now });
    expect(answer).toEqual({ kind: 'closed', status: 'expired' });
    expect(shop.sandbox.creates()).toHaveLength(1);
    expect(await payment(orderId)).toMatchObject({ status: 'expired', failure_code: 'session_unconfirmed', provider_session_id: null });
    expect(await reserved(ring.item)).toBe(0);
    expect(await eventIds(orderId)).toEqual([SESSION_EVENT.unconfirmed(orderId)]);
  });

  it('at the margin a session another click stored meanwhile is read, not given up', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    shop.sandbox.nextCreate.push('lost');
    await click(orderId);
    const stale = await pinOf(orderId);
    await click(orderId);
    const session = shop.sandbox.only();
    clock.now = at(14 * MINUTE);
    expect(await openCheckoutSession(shop.deps, await checkoutOrder(orderId), stale, { now: clock.now })).toEqual({ kind: 'redirect', url: session.url });
    expect((await payment(orderId)).status).toBe('pending');
  });
});

describe('E: a later click, an error Stripe stored, and the order past its window', () => {
  it('a complete session on a later click applies the success under session:<id>; the real delivery later changes nothing', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    const session = shop.sandbox.only();
    shop.sandbox.pay(session.id);
    clock.now = at(8 * MINUTE);
    const { answer } = await click(orderId);
    expect(answer).toMatchObject({ kind: 'paid', outcome: { status: 'paid' } });
    expect(await payment(orderId)).toMatchObject({ status: 'paid', provider_payment_id: session.payment_intent });
    expect(await eventIds(orderId)).toEqual([SESSION_EVENT.success(session.id)]);

    const late = await handlePaymentEvent(
      shop.deps,
      webhookEvent(orderId, 'payment_succeeded', { amount: 4900, currency: 'EUR', providerPaymentId: session.payment_intent! }),
    );
    expect(late).toMatchObject({ status: 'paid', duplicate: false, jobIds: [] });
    expect(await reserved(ring.item)).toBe(1);
  });

  it('an expired session on a later click closes the payment; a replayed create would still have said open', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    const session = shop.sandbox.only();
    shop.sandbox.expire(session.id);
    clock.now = at(46 * MINUTE);
    expect((await click(orderId)).answer).toEqual({ kind: 'closed', status: 'expired' });
    expect(await payment(orderId)).toMatchObject({ status: 'expired', failure_code: 'session_expired' });
    expect(await reserved(ring.item)).toBe(0);
    expect(shop.sandbox.creates()).toHaveLength(1);
  });

  it('a complete session with its money still on the way answers processing and changes nothing', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    Object.assign(shop.sandbox.only(), { status: 'complete', payment_status: 'unpaid', url: null });
    expect((await click(orderId)).answer).toEqual({ kind: 'processing' });
    expect((await payment(orderId)).status).toBe('pending');
  });

  it('Stripe unreachable or a gateway page on a later click: unavailable, nothing changes', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    shop.sandbox.nextRetrieve.push('unreachable', 'gateway');
    expect((await click(orderId)).answer).toEqual({ kind: 'unavailable' });
    expect((await click(orderId)).answer).toEqual({ kind: 'unavailable' });
    expect((await payment(orderId)).status).toBe('pending');
  });

  it.each([
    ['a 400', 'refuse', 'parameter_invalid'],
    ['a 500', 'fail500', 'api_error'],
  ] as const)('a create Stripe answered with %s closes the payment: every retry under the key would replay it', async (_name, mode, code) => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    shop.sandbox.nextCreate.push(mode);
    expect((await click(orderId)).answer).toEqual({ kind: 'closed', status: 'cancelled' });
    expect(await payment(orderId)).toMatchObject({ status: 'cancelled', failure_code: code });
    expect(await reserved(ring.item)).toBe(0);
    expect(await eventIds(orderId)).toEqual([SESSION_EVENT.refused(orderId)]);
  });

  it('a key Stripe holds for another request (a session the build before made) leaves the payment waiting for its hold', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    shop.sandbox.byKey.set(`checkout:${orderId}`, { body: 'the earlier build request', status: 200, json: { id: 'cs_old', url: 'https://old' } });
    expect((await click(orderId)).answer).toEqual({ kind: 'key_conflict' });
    expect(await payment(orderId)).toMatchObject({ status: 'pending', provider_session_id: null });
    expect(await reserved(ring.item)).toBe(1);
  });

  it('cutover: a session the build before confirmed (028) keeps its buyer, refuses another, and Stripe is not asked', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await env.ownerDb
      .updateTable('order_payment')
      .set({ checkout_request: toJsonb({ buyerEmail: BUYER.email, returnUrl: RETURN_URL, confirmed: true }) })
      .where('order_id', '=', orderId)
      .execute();
    expect((await click(orderId, OTHER_BUYER)).pinned).toEqual({ ok: false, reason: 'buyer_fixed' });
    expect((await payment(orderId)).session_expires_at).toBeNull();

    const same = await click(orderId);
    expect(same.answer).toEqual({ kind: 'key_conflict' });
    // The hold outlasts the earlier build's session too: its window (30 minutes) plus its 31, plus the grace.
    expect(await payment(orderId)).toMatchObject({ status: 'pending', buyer: { email: BUYER.email }, expires_at: at(66 * MINUTE) });
    // Past the margin too: no close while that session may still be paid; the hold ends it.
    clock.now = at(20 * MINUTE);
    expect((await click(orderId)).answer).toEqual({ kind: 'key_conflict' });
    expect(shop.sandbox.requests).toHaveLength(0);
    clock.now = at(65 * MINUTE);
    expect(await sweepExpiredPayments(shop.deps, shop.company, { orderId })).toEqual([]);
    clock.now = at(67 * MINUTE);
    expect(await sweepExpiredPayments(shop.deps, shop.company, { orderId })).toEqual([orderId]);
  });

  it('cutover, a late click: the hold still ends no earlier than the pin plus 50 minutes', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await env.ownerDb
      .updateTable('order_payment')
      .set({ checkout_request: toJsonb({ buyerEmail: BUYER.email, returnUrl: RETURN_URL, confirmed: true }) })
      .where('order_id', '=', orderId)
      .execute();
    clock.now = at(29 * MINUTE);
    await click(orderId);
    expect((await payment(orderId)).expires_at).toEqual(at(79 * MINUTE));
  });

  it('no pin on a payment past its window, nor on one no longer pending', async () => {
    const ring = await stockedRing(2);
    const late = await placeOrder(ring);
    clock.now = at(30 * MINUTE);
    expect((await click(late)).pinned).toEqual({ ok: false, reason: 'window_over' });
    expect((await payment(late)).session_expires_at).toBeNull();

    clock.now = T0;
    const closed = await placeOrder(ring);
    await handlePaymentEvent(shop.deps, webhookEvent(closed, 'checkout_cancelled'));
    expect((await click(closed)).pinned).toEqual({ ok: false, reason: 'not_pending' });
    expect(shop.sandbox.requests).toHaveLength(0);
  });
});

describe('E: the expiry job asks Stripe before it closes a payment with a stored session', () => {
  async function pinnedAndStored(stock = 1) {
    const ring = await stockedRing(stock);
    const orderId = await placeOrder(ring);
    await click(orderId);
    return { ring, orderId, session: shop.sandbox.only() };
  }

  it('complete: the success is applied under session:<id> with its PaymentIntent, and the job is done', async () => {
    const { ring, orderId, session } = await pinnedAndStored();
    shop.sandbox.pay(session.id);
    clock.now = at(50 * MINUTE);
    await runExpiryJob();
    expect(await payment(orderId)).toMatchObject({ status: 'paid', provider_payment_id: session.payment_intent });
    expect(await eventIds(orderId)).toEqual([SESSION_EVENT.success(session.id)]);
    expect((await expiryJob(orderId)).status).toBe('done');
    expect(await reserved(ring.item)).toBe(1);
  });

  it('expired: closed by our clock, once', async () => {
    const { ring, orderId, session } = await pinnedAndStored();
    shop.sandbox.expire(session.id);
    clock.now = at(50 * MINUTE);
    await runExpiryJob();
    expect(await payment(orderId)).toMatchObject({ status: 'expired' });
    expect(await eventIds(orderId)).toEqual([`expiry:${orderId}`]);
    expect((await expiryJob(orderId)).status).toBe('done');
    expect(await reserved(ring.item)).toBe(0);
  });

  it('open: asked again in 5 minutes, then closed once Stripe says it expired', async () => {
    const { orderId, session } = await pinnedAndStored();
    clock.now = at(50 * MINUTE);
    await runExpiryJob();
    expect(await expiryJob(orderId)).toMatchObject({ status: 'pending', run_at: at(55 * MINUTE) });
    expect((await payment(orderId)).status).toBe('pending');
    shop.sandbox.expire(session.id);
    clock.now = at(55 * MINUTE);
    await runExpiryJob();
    expect((await payment(orderId)).status).toBe('expired');
  });

  it('Stripe unreachable: retried, and an hour past the hold closed without its word', async () => {
    const { ring, orderId } = await pinnedAndStored();
    clock.now = at(50 * MINUTE);
    shop.sandbox.nextRetrieve.push('unreachable');
    await runExpiryJob();
    expect(await expiryJob(orderId)).toMatchObject({ status: 'pending', run_at: at(55 * MINUTE), last_error: 'stripe_unreachable' });
    expect((await payment(orderId)).status).toBe('pending');

    // Still unreachable 58 minutes past the hold: the next try is due no later than the hour.
    clock.now = at(108 * MINUTE);
    shop.sandbox.nextRetrieve.push('unreachable');
    await runExpiryJob();
    expect((await expiryJob(orderId)).run_at).toEqual(at(110 * MINUTE));

    clock.now = at(110 * MINUTE);
    shop.sandbox.nextRetrieve.push('unreachable');
    await runExpiryJob();
    expect((await payment(orderId)).status).toBe('expired');
    expect((await expiryJob(orderId)).status).toBe('done');
    expect(await reserved(ring.item)).toBe(0);
  });

  it('a pin without a stored session closes by our clock without asking Stripe, and the sweep leaves a stored one to its job', async () => {
    const ring = await stockedRing(2);
    const unstored = await placeOrder(ring);
    shop.sandbox.nextCreate.push('unreachable');
    await click(unstored);
    const stored = await placeOrder(ring);
    await click(stored);
    clock.now = at(51 * MINUTE);
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([unstored]);
    expect((await payment(stored)).status).toBe('pending');
    expect(shop.sandbox.retrieves()).toHaveLength(0);
  });
});

describe('review fixes: a close racing a create, closes under the lock, the pinned account, the sweep', () => {
  it('B1: a click closing at the margin while another click\'s create is in flight: the late session is expired, not stored', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    const pinA = await pinOf(orderId);
    // Click A's create reaches Stripe at 13:30, before the margin; its answer comes back only after click B closed.
    clock.now = at(13 * MINUTE + 30_000);
    let closedByB: unknown;
    shop.sandbox.beforeCreateAnswer.push(async () => {
      clock.now = at(14 * MINUTE);
      closedByB = await openCheckoutSession(shop.deps, await checkoutOrder(orderId), await pinOf(orderId), { now: clock.now });
    });
    const answerA = await openCheckoutSession(shop.deps, await checkoutOrder(orderId), pinA, { now: at(13 * MINUTE + 30_000) });
    expect(closedByB).toEqual({ kind: 'closed', status: 'expired' });
    expect(answerA).toEqual({ kind: 'closed', status: 'expired' });
    const session = shop.sandbox.only();
    expect(session.status).toBe('expired');
    expect(shop.sandbox.expires()).toHaveLength(1);
    expect(await payment(orderId)).toMatchObject({ status: 'expired', provider_session_id: null });
    expect(await reserved(ring.item)).toBe(0);
  });

  it('B1: an outdated order closed while a create is in flight: the session is expired; if Stripe cannot, it is logged loudly', async () => {
    const ring = await stockedRing(2);
    for (const expireFails of [false, true]) {
      const orderId = await placeOrder(ring);
      const pin = await pinOf(orderId);
      if (expireFails) shop.sandbox.nextExpire.push('unreachable');
      shop.sandbox.beforeCreateAnswer.push(async () => {
        await handlePaymentEvent(shop.deps, { ...webhookEvent(orderId, 'checkout_cancelled'), eventId: `order-outdated:${orderId}`, requireNoSession: true });
      });
      const errors = vi.mocked(console.error);
      errors.mockClear();
      expect(await openCheckoutSession(shop.deps, await checkoutOrder(orderId), pin, { now: clock.now })).toEqual({ kind: 'closed', status: 'cancelled' });
      expect((await payment(orderId)).provider_session_id).toBeNull();
      const created = [...shop.sandbox.sessions.values()].at(-1)!;
      expect(created.status).toBe(expireFails ? 'open' : 'expired');
      expect(errors.mock.calls.some((c) => String(c[0]).includes('could NOT be expired'))).toBe(expireFails);
    }
  });

  it('B1: a close decided here finds a session stored under the lock and reads it instead (the outdated order, the margin)', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    const outdated = await handlePaymentEvent(shop.deps, { ...webhookEvent(orderId, 'checkout_cancelled'), requireNoSession: true });
    expect(outdated).toMatchObject({ status: 'pending', sessionStored: shop.sandbox.only().id });
    expect(await eventIds(orderId)).toEqual([]);
    expect(await reserved(ring.item)).toBe(1);
  });

  it('B1 hardening: no create once less than the margin plus the click\'s wait is left; it closes instead', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    const pin = await pinOf(orderId);
    clock.now = at(13 * MINUTE + 50_000);
    expect(await openCheckoutSession(shop.deps, await checkoutOrder(orderId), pin, { now: clock.now })).toEqual({ kind: 'closed', status: 'expired' });
    expect(shop.sandbox.creates()).toHaveLength(0);
  });

  it('M1: a session found expired on a payment paid meanwhile answers its real status, never "nothing charged"', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    const session = shop.sandbox.only();
    shop.sandbox.expire(session.id);
    shop.sandbox.beforeRetrieveAnswer.push(async () => {
      await handlePaymentEvent(shop.deps, webhookEvent(orderId, 'payment_succeeded', { amount: 4900, currency: 'EUR', providerPaymentId: 'pi_x' }));
    });
    expect((await click(orderId)).answer).toEqual({ kind: 'closed', status: 'paid' });
    expect((await payment(orderId)).status).toBe('paid');
  });

  it('M2: Stripe failing on the account lookup pins nothing and closes nothing; the lookup gets the click\'s signal', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await env.ownerDb.updateTable('payment_account').set({ status: 'pending', charges_enabled: false }).where('tenant_id', '=', shop.company).execute();
    shop.sandbox.nextAccount.push('fail500');
    const signal = new AbortController().signal;
    const pinned = await pinCheckoutSession(env.appDb, shop.company, orderId, BUYER as never, RETURN_URL, clock.now, account(signal));
    expect(pinned).toEqual({ ok: false, reason: 'stripe_unavailable' });
    expect(await payment(orderId)).toMatchObject({ status: 'pending', session_expires_at: null });
    const lookup = shop.sandbox.requests.find((r) => r.path.startsWith('/v1/accounts/'))!;
    expect(lookup.signal).toBe(signal);
    // The account answers now: the pin goes through on it, and the create is the only call inside the click's catch.
    expect((await click(orderId)).answer).toMatchObject({ kind: 'redirect' });
  });

  it('M2: a company without an account that can take payments gets no pin', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await env.ownerDb.deleteFrom('payment_account').where('tenant_id', '=', shop.company).execute();
    expect((await click(orderId)).pinned).toEqual({ ok: false, reason: 'no_account' });
    expect((await payment(orderId)).session_expires_at).toBeNull();
  });

  it('M3: a company that connects another account later still reads its session on the account it was made on', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    const first = await click(orderId);
    expect((await payment(orderId)).session_account_id).toBe(shop.accountId);
    // An operator disconnects the account and the company connects another one.
    await env.ownerDb.deleteFrom('payment_account').where('tenant_id', '=', shop.company).execute();
    await env.ownerDb
      .insertInto('payment_account')
      .values({ tenant_id: shop.company, provider: 'stripe', account_id: `acct_${randomBytes(8).toString('hex')}`, status: 'ready', charges_enabled: true, details_submitted: true, updated_at: T0 })
      .execute();
    expect((await click(orderId)).answer).toEqual(first.answer);
    expect(shop.sandbox.retrieves()[0].headers['stripe-account']).toBe(shop.accountId);
  });

  it('M6: a stored session Stripe does not know on its account closes the payment on a click', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await click(orderId);
    shop.sandbox.sessions.clear();
    expect((await click(orderId)).answer).toEqual({ kind: 'closed', status: 'expired' });
    expect(await payment(orderId)).toMatchObject({ status: 'expired', failure_code: 'session_missing' });
    expect(await reserved(ring.item)).toBe(0);
  });

  it('M4: the sweep takes a stored session an hour past its hold by the job\'s rule: closes an expired one, applies a paid one', async () => {
    const ring = await stockedRing(2);
    const expiredOrder = await placeOrder(ring);
    await click(expiredOrder);
    const paidOrder = await placeOrder(ring);
    await click(paidOrder);
    const [expiredSession, paidSession] = [...shop.sandbox.sessions.values()];
    shop.sandbox.expire(expiredSession.id);
    shop.sandbox.pay(paidSession.id);
    clock.now = at(109 * MINUTE);
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([]);
    clock.now = at(111 * MINUTE);
    expect(await sweepExpiredPayments(shop.deps, shop.company)).toEqual([expiredOrder]);
    expect((await payment(expiredOrder)).status).toBe('expired');
    expect(await payment(paidOrder)).toMatchObject({ status: 'paid', provider_payment_id: paidSession.payment_intent });
  });
});

describe('031_checkout_session guarantees (BK018 and the checks)', () => {
  const update = (orderId: string, set: Record<string, unknown>) =>
    env.appDb.updateTable('order_payment').set(set).where('order_id', '=', orderId).execute();

  it('once pinned: the end, the return address, the hold and the buyer are fixed, and the session id is set once', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await pinOf(orderId);
    expect(await rejectionCode(update(orderId, { session_expires_at: at(60 * MINUTE) }))).toBe('BK018');
    expect(await rejectionCode(update(orderId, { session_return_url: 'https://elsewhere.example/' }))).toBe('BK018');
    expect(await rejectionCode(update(orderId, { session_account_id: 'acct_other' }))).toBe('BK018');
    expect(await rejectionCode(update(orderId, { expires_at: at(90 * MINUTE) }))).toBe('BK018');
    expect(await rejectionCode(update(orderId, { buyer: toJsonb(OTHER_BUYER) }))).toBe('BK018');
    await update(orderId, { provider_session_id: 'cs_test_first' });
    expect(await rejectionCode(update(orderId, { provider_session_id: 'cs_test_second' }))).toBe('BK018');
    expect(await rejectionCode(update(orderId, { provider_session_id: null }))).toBe('BK018');
  });

  it('only a pending Stripe payment is pinned, both halves together, the hold past the end, one payment per session', async () => {
    const ring = await stockedRing(4);
    const closed = await placeOrder(ring);
    await handlePaymentEvent(shop.deps, webhookEvent(closed, 'checkout_cancelled'));
    const pin = { session_expires_at: at(45 * MINUTE), session_return_url: RETURN_URL, session_account_id: shop.accountId, expires_at: at(50 * MINUTE) };
    expect(await rejectionCode(update(closed, pin))).toBe('BK018');

    const open = await placeOrder(ring);
    expect(await rejectionCode(update(open, { session_expires_at: at(45 * MINUTE), expires_at: at(50 * MINUTE) }))).toBe('23514');
    expect(await rejectionCode(update(open, { ...pin, session_account_id: null }))).toBe('23514');
    expect(await rejectionCode(update(open, { provider_session_id: 'cs_test_unpinned' }))).toBe('23514');
    expect(await rejectionCode(update(open, { ...pin, expires_at: at(45 * MINUTE) }))).toBe('23514');

    const demo = await placeOrder(ring, 'demo');
    expect(await rejectionCode(update(demo, pin))).toBe('23514');

    await update(open, { ...pin, provider_session_id: 'cs_test_shared' });
    const second = await placeOrder(ring);
    expect(await rejectionCode(update(second, { ...pin, provider_session_id: 'cs_test_shared' }))).toBe('23505');
  });

  it('a session id is stored only on a pending payment, never on one that closed (BK018)', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    await pinOf(orderId);
    await handlePaymentEvent(shop.deps, webhookEvent(orderId, 'checkout_cancelled'));
    expect(await rejectionCode(update(orderId, { provider_session_id: 'cs_test_late' }))).toBe('BK018');
  });

  it('a payment starts without a session', async () => {
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    // The same pending row again, under a session: refused by the guard, before the primary key is even checked.
    const table = sql.id(env.schema, 'order_payment');
    const insert = sql`
      INSERT INTO ${table} ("tenant_id", "order_id", "provider", "amount", "currency_code", "application_fee_amount",
                                   "buyer", "expires_at", "updated_at", "session_expires_at", "session_return_url")
      SELECT "tenant_id", "order_id", "provider", "amount", "currency_code", "application_fee_amount",
             "buyer", "expires_at", "updated_at", "expires_at" - interval '1 minute', ${RETURN_URL}
        FROM ${table} WHERE "order_id" = ${orderId}`.execute(env.appDb);
    expect(await rejectionCode(insert)).toBe('BK018');
  });
});
