// src/app/api/payments/stripe/__tests__/stripe-flow.itest.ts
//
// Stripe Connect end to end against real Postgres and a FAKE Stripe (slice 5; the real Stripe path is
// unproven until an account exists). Through the real webhook route with signed deliveries:
//   - onboarding stores the company's account (pending), the return asks Stripe and marks it ready;
//   - an order of a ready company is paid through a hosted checkout: a direct charge on the company's own
//     account with the 1% fee, the session living at least Stripe's minimum;
//   - forward: payment_intent.succeeded pays and issues the receipt; delivered twice changes nothing;
//   - a declined card closes the order and releases its stock;
//   - late with the stock gone: refunded on the company's account (the fee returned), the order closed;
//   - refused: a bad signature (400), an event from another connected account (ignored), an amount that
//     differs (ignored); a receipt that cannot be issued yet answers 500 so Stripe delivers again.
// All data is synthetic; secrets are built at run time.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  directory: null as unknown,
  contactBook: null as unknown,
  stripe: null as unknown,
}));

vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: async () => state.db,
  isCommerceTenantNotProvisioned: () => false,
}));
vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));
vi.mock('@/server/commerce/payment/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/commerce/payment/stripe/client')>()),
  httpStripeApi: () => state.stripe,
}));

import { POST as webhook } from '../webhook/route';
import { catalogRepository } from '@/server/commerce/repository/catalog';
import { pricingRepository } from '@/server/commerce/repository/pricing';
import { createOrder } from '@/server/commerce/order/createOrder';
import { refreshAccount, startOnboarding, stripeProvider, readAccount } from '@/server/commerce/payment/stripe/connect';
import type { StripeApi } from '@/server/commerce/payment/stripe/client';
import { signStripePayload } from '@/server/commerce/payment/stripe/webhook';
import { oauthCallback, onboardingReturn } from '@/server/commerce/payment/stripe/ownerHandlers';
import { oauthState } from '@/server/commerce/payment/stripe/connect';
import type { OwnerContext } from '@/server/commerce/payment/stripe/ownerRoute';
import { booksScope } from '@/server/books/scope';
import { FakeContactBook, FakeDirectory, initCompany, openBooksEnv, type BooksEnv } from '@/server/books/__tests__/booksFixtures';

const fake = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const WEBHOOK_SECRET = fake('test-hook');

let env: BooksEnv;

/** A fake Stripe recording every call; accounts become ready when `ready` holds their id. */
class FakeStripe implements StripeApi {
  calls: Array<{ op: string; args: unknown }> = [];
  ready = new Set<string>();
  async createAccount(args: { email?: string; country: string }) {
    this.calls.push({ op: 'createAccount', args });
    return { id: `acct_${randomBytes(8).toString('hex')}`, charges_enabled: false, details_submitted: false };
  }
  async retrieveAccount(accountId: string) {
    this.calls.push({ op: 'retrieveAccount', args: accountId });
    const ready = this.ready.has(accountId);
    return { id: accountId, charges_enabled: ready, details_submitted: ready };
  }
  async createAccountLink(args: { accountId: string; refreshUrl: string; returnUrl: string }) {
    this.calls.push({ op: 'createAccountLink', args });
    return { url: `https://connect.stripe.test/setup/${args.accountId}` };
  }
  async oauthToken(code: string) {
    this.calls.push({ op: 'oauthToken', args: code });
    return { stripeUserId: `acct_${code}` };
  }
  async createCheckoutSession(args: Parameters<StripeApi['createCheckoutSession']>[0]) {
    this.calls.push({ op: 'createCheckoutSession', args });
    return { id: `cs_${randomBytes(6).toString('hex')}`, url: 'https://checkout.stripe.test/pay' };
  }
  async createRefund(args: { accountId: string; paymentIntentId: string; idempotencyKey: string }) {
    this.calls.push({ op: 'createRefund', args });
    return { id: `re_${randomBytes(6).toString('hex')}` };
  }
}

let stripe: FakeStripe;
let company: string;
let accountId: string;

beforeAll(async () => {
  env = await openBooksEnv('stripe-flow');
  state.db = env.appDb;
  vi.stubEnv('STRIPE_SECRET_KEY', fake('test-secret'));
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
  vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', fake('test-client'));
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await env?.close();
});

/** A fresh company with its Books set up and a READY Stripe account, through onboarding and the return. */
async function readyCompany(opts: { books?: boolean } = {}) {
  company = randomUUID();
  stripe = new FakeStripe();
  state.stripe = stripe;
  const dir = new FakeDirectory();
  state.directory = dir;
  state.contactBook = new FakeContactBook(dir);
  if (opts.books !== false) {
    await initCompany(booksScope(env.appDb, env.tgId, company, { recipients: dir }), { taxStatus: 'regular', invoiceNext: 500 });
  }
  const link = await startOnboarding(env.appDb, stripe, {
    tenantId: company,
    email: 'owner@example.com',
    country: 'DE',
    refreshUrl: 'https://app.example/projects/payments?stripe=refresh',
    returnUrl: 'https://app.example/api/payments/stripe/return',
  });
  accountId = (await readAccount(env.appDb, company)).accountId!;
  expect(link.url).toBe(`https://connect.stripe.test/setup/${accountId}`);
  expect((await readAccount(env.appDb, company)).status).toBe('pending');
  // Onboarding again resumes the same account (no second one).
  await startOnboarding(env.appDb, stripe, { tenantId: company, country: 'DE', refreshUrl: 'r', returnUrl: 'r' });
  expect(stripe.calls.filter((c) => c.op === 'createAccount')).toHaveLength(1);
  stripe.ready.add(accountId);
  expect((await refreshAccount(env.appDb, stripe, company)).status).toBe('ready');
}

beforeEach(async () => {
  await readyCompany();
});

async function stockedRing(stock: number) {
  const db = env.ownerDb;
  const p = await catalogRepository.createProduct(db, { tenantId: company, title: 'Ring', handle: `ring-${randomUUID().slice(0, 8)}`, status: 'published' });
  const sku = `RING-${randomUUID()}`;
  const v = await catalogRepository.addVariant(db, { tenantId: company, productId: p.id, sku });
  const set = await pricingRepository.createPriceSet(db, { tenantId: company, variantId: v.id });
  await pricingRepository.addPrice(db, { tenantId: company, priceSetId: set.id, currency: 'EUR', amount: 999 });
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

async function stripeOrder(ring: Awaited<ReturnType<typeof stockedRing>>) {
  const result = await createOrder(env.appDb, env.tgId, {
    tenantId: company,
    siteId: 'site-1',
    requestId: `rq-${randomUUID()}`,
    currency: 'EUR',
    taxRegion: 'DE',
    netOrGross: 'gross',
    lines: [{ inventoryItemId: ring.item, variantId: ring.variantId, quantity: 1, locationId: ring.location, variantRef: ring.variantId, variantRefSource: 'owned' }],
    payment: {
      provider: 'stripe',
      buyer: { kind: 'person', name: 'Alex Example', email: 'alex@example.com', addressLine1: 'Beispielweg 2', postalCode: '20095', city: 'Hamburg', country: 'DE' },
    },
  });
  if (!result.ok) throw new Error('short');
  return result.orderId;
}

function deliver(type: string, object: Record<string, unknown>, opts: { eventId?: string; account?: string; secret?: string } = {}) {
  const body = JSON.stringify({
    id: opts.eventId ?? `evt_${randomBytes(6).toString('hex')}`,
    type,
    account: opts.account ?? accountId,
    data: { object },
  });
  return webhook(
    new Request('https://app.example/api/payments/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signStripePayload(body, opts.secret ?? WEBHOOK_SECRET, Math.floor(Date.now() / 1000)) },
      body,
    }),
  );
}

const metadata = (orderId: string) => ({ order_id: orderId, tenant_id: company, tenant_group_id: env.tgId });
const succeeded = (orderId: string, amount = 999) => ({ id: `pi_${orderId}`, amount, amount_received: amount, currency: 'eur', metadata: metadata(orderId) });

async function paymentOf(orderId: string) {
  return env.ownerDb.selectFrom('order_payment').selectAll().where('order_id', '=', orderId).executeTakeFirstOrThrow();
}

async function reserved(item: string) {
  return (await env.ownerDb.selectFrom('inventory_level').select('reserved_quantity').where('inventory_item_id', '=', item).executeTakeFirstOrThrow())
    .reserved_quantity;
}

describe('Stripe Connect through the webhook (fake Stripe)', () => {
  it('a hosted checkout is a direct charge on the company account with the 1% fee', async () => {
    const ring = await stockedRing(2);
    const orderId = await stripeOrder(ring);
    const payment = await paymentOf(orderId);
    expect(payment).toMatchObject({ provider: 'stripe', amount: 999, application_fee_amount: 10 });
    const started = await stripeProvider(stripe, { db: env.appDb, tenantId: company, tenantGroupId: env.tgId }).start(
      {
        tenantId: company,
        orderId,
        orderNumber: 'ORD-1',
        amount: payment.amount,
        currency: 'EUR',
        applicationFeeAmount: payment.application_fee_amount,
        buyerEmail: 'alex@example.com',
        returnUrl: 'https://shop.example/cart',
        expiresAt: payment.expires_at,
      },
      async () => {},
    );
    expect(started.redirectUrl).toBe('https://checkout.stripe.test/pay');
    const session = stripe.calls.find((c) => c.op === 'createCheckoutSession')!.args as Record<string, unknown>;
    expect(session).toMatchObject({
      accountId,
      amount: 999,
      applicationFeeAmount: 10,
      tenantId: company,
      tenantGroupId: env.tgId,
      idempotencyKey: `checkout:${orderId}`,
      successUrl: 'https://shop.example/cart?checkout=paid&order=ORD-1',
    });
    expect(session.expiresAt as number).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 60);
  });

  it('forward: payment_intent.succeeded pays and issues the receipt; the same event twice changes nothing', async () => {
    const ring = await stockedRing(2);
    const orderId = await stripeOrder(ring);
    const first = await deliver('payment_intent.succeeded', succeeded(orderId), { eventId: 'evt_same' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, status: 'paid', duplicate: false });
    const paid = await paymentOf(orderId);
    expect(paid).toMatchObject({ status: 'paid', provider_payment_id: `pi_${orderId}` });
    expect(paid.receipt_document_id).not.toBeNull();
    const again = await deliver('payment_intent.succeeded', succeeded(orderId), { eventId: 'evt_same' });
    expect(await again.json()).toEqual({ received: true, status: 'paid', duplicate: true });
    const receipts = await env.ownerDb.selectFrom('sales_document').select('id').where('source_order_id', '=', orderId).execute();
    expect(receipts).toHaveLength(1);
  });

  it('a declined card closes the order and gives its stock back', async () => {
    const ring = await stockedRing(1);
    const orderId = await stripeOrder(ring);
    expect(await reserved(ring.item)).toBe(1);
    const res = await deliver('payment_intent.payment_failed', {
      id: `pi_${orderId}`,
      currency: 'eur',
      metadata: metadata(orderId),
      last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
    });
    expect(await res.json()).toMatchObject({ status: 'failed' });
    expect(await paymentOf(orderId)).toMatchObject({ status: 'failed', failure_code: 'insufficient_funds' });
    expect(await reserved(ring.item)).toBe(0);
  });

  it('late with the stock gone: refunded on the company account with the fee, the order closed', async () => {
    const ring = await stockedRing(1);
    const orderId = await stripeOrder(ring);
    expect(await (await deliver('checkout.session.expired', { id: 'cs_x', metadata: metadata(orderId) })).json()).toMatchObject({ status: 'expired' });
    const other = await stripeOrder(ring);
    await deliver('payment_intent.succeeded', succeeded(other));
    const late = await deliver('payment_intent.succeeded', succeeded(orderId));
    expect(await late.json()).toMatchObject({ status: 'refunded' });
    const refund = stripe.calls.find((c) => c.op === 'createRefund')!.args;
    expect(refund).toEqual({ accountId, paymentIntentId: `pi_${orderId}`, idempotencyKey: `refund:pi_${orderId}` });
  });

  it('refuses a bad signature, ignores another account and another amount', async () => {
    const ring = await stockedRing(2);
    const orderId = await stripeOrder(ring);
    expect((await deliver('payment_intent.succeeded', succeeded(orderId), { secret: fake('wrong') })).status).toBe(400);
    expect(await (await deliver('payment_intent.succeeded', succeeded(orderId), { account: 'acct_intruder' })).json()).toMatchObject({
      ignored: 'account_mismatch',
    });
    expect(await (await deliver('payment_intent.succeeded', succeeded(orderId, 1))).json()).toMatchObject({ ignored: 'amount_mismatch' });
    expect((await paymentOf(orderId)).status).toBe('pending');
  });

  it('a receipt that cannot be issued yet answers 500 so Stripe delivers again; the payment stands', async () => {
    await readyCompany({ books: false });
    const ring = await stockedRing(2);
    const orderId = await stripeOrder(ring);
    const res = await deliver('payment_intent.succeeded', succeeded(orderId));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('receipt_pending');
    expect((await paymentOf(orderId)).status).toBe('paid');
  });
});

describe('connecting an account (owner routes)', () => {
  const config = { secretKey: fake('test-secret'), webhookSecret: WEBHOOK_SECRET, connectClientId: fake('test-client') };
  const ctxFor = (companyId: string): OwnerContext => ({
    db: env.appDb,
    companyId,
    tenantGroupId: env.tgId,
    email: 'owner@example.com',
    api: stripe,
    config,
  });
  const get = (path: string) => new Request(`https://app.example${path}`, { headers: { host: 'app.example', 'x-forwarded-proto': 'https' } });

  it('OAuth: a state for this company connects the existing account; a foreign or forged state changes nothing', async () => {
    const owner = randomUUID();
    const foreign = oauthState(config, randomUUID());
    const refused = await oauthCallback(ctxFor(owner), get(`/api/payments/stripe/oauth/callback?code=existing1&state=${foreign}`));
    expect(refused.headers.get('location')).toBe('https://app.example/projects/payments?stripe=invalid_state');
    expect((await readAccount(env.appDb, owner)).status).toBe('not_connected');

    stripe.ready.add('acct_existing1');
    const ok = await oauthCallback(
      ctxFor(owner),
      get(`/api/payments/stripe/oauth/callback?code=existing1&state=${encodeURIComponent(oauthState(config, owner))}`),
    );
    expect(ok.headers.get('location')).toBe('https://app.example/projects/payments?stripe=ready');
    expect(await readAccount(env.appDb, owner)).toEqual({ status: 'ready', accountId: 'acct_existing1' });

    // A second connect with another account is refused: the connected account is fixed.
    const second = await oauthCallback(
      ctxFor(owner),
      get(`/api/payments/stripe/oauth/callback?code=existing2&state=${encodeURIComponent(oauthState(config, owner))}`),
    );
    expect(second.headers.get('location')).toBe('https://app.example/projects/payments?stripe=failed');
    expect((await readAccount(env.appDb, owner)).accountId).toBe('acct_existing1');
  });

  it('OAuth cancelled at Stripe, and the return from onboarding asks Stripe for readiness', async () => {
    const owner = randomUUID();
    const cancelled = await oauthCallback(
      ctxFor(owner),
      get(`/api/payments/stripe/oauth/callback?error=access_denied&state=${encodeURIComponent(oauthState(config, owner))}`),
    );
    expect(cancelled.headers.get('location')).toBe('https://app.example/projects/payments?stripe=access_denied');

    // The beforeEach company is ready; one more not yet ready shows pending on return.
    const pendingOwner = randomUUID();
    await startOnboarding(env.appDb, stripe, { tenantId: pendingOwner, country: 'DE', refreshUrl: 'r', returnUrl: 'r' });
    const back = await onboardingReturn(ctxFor(pendingOwner), get('/api/payments/stripe/return'));
    expect(back.headers.get('location')).toBe('https://app.example/projects/payments?stripe=pending');
  });
});
