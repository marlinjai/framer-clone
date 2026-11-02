// src/app/api/commerce/orders/[orderId]/pay/__tests__/secondPay.itest.ts
//
// Pressing Pay again on a Stripe order (the money review of 2026-11-02, finding 5). The checkout session is created
// under the idempotency key `checkout:<orderId>`, and Stripe answers a repeated key with the same session only for the
// same request, refusing it otherwise. The fake Stripe below keeps that rule, so a request that drifts between clicks
// fails here as it would there. Through the real order and pay routes on Postgres:
//
//   - forward: the first click opens a session and fixes its request and buyer;
//   - resume: a buyer back from Stripe presses Pay again, later and from another page, and gets the same session;
//   - backtrack: another buyer on an order whose session Stripe confirmed is refused (409 buyer_fixed), the first buyer
//     stays, Stripe is not asked; but while no session is confirmed (Stripe failed on the first click), the buyer may
//     correct their details and the corrected ones are what the session is made out to (second round, R2-3);
//   - re-entry: two clicks at once agree on one request and one session; the database refuses a later change of the
//     request or the buyer (BK018).
// All data is synthetic.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: null as unknown, contactBook: null as unknown, stripe: null as unknown }));

vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));

vi.mock('@/server/commerce/payment/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/commerce/payment/stripe/client')>()),
  httpStripeApi: () => state.stripe,
}));

import { DEMO_COMPANY_ID } from '@/lib/renderer/server/demoTenant';
import { FakeContactBook, FakeDirectory, initCompany, rejectionCode } from '@/server/books/__tests__/booksFixtures';
import { booksScope } from '@/server/books/scope';
import { toJsonb } from '@/server/books/snapshots';
import {
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { StripeApiError, type StripeApi } from '@/server/commerce/payment/stripe/client';
import { refreshAccount, startOnboarding } from '@/server/commerce/payment/stripe/connect';
import { POST as placeOrder } from '../../../route';
import { POST as pay } from '../route';

let fx: StorefrontFixtures;
let tenant: ProvisionedTenant;
let host: string;

const PROVISIONING_TIMEOUT = 300_000;

/** Stripe's idempotency rule: one key, one request; the same request answers the same session, another is refused. */
class IdempotentStripe {
  private readonly byKey = new Map<string, { body: string; session: { id: string; url: string } }>();
  created = 0;
  refused = 0;
  /** The next calls fail as Stripe being unreachable would, before anything is stored under the key. */
  failNext = 0;
  /** The email of every session created, in order. */
  emails: string[] = [];
  createAccount = async () => ({ id: `acct_${randomBytes(6).toString('hex')}`, charges_enabled: false, details_submitted: false });
  retrieveAccount = async (id: string) => ({ id, charges_enabled: true, details_submitted: true });
  createAccountLink = async () => ({ url: 'https://connect.stripe.test/setup' });
  createCheckoutSession = async (args: Record<string, unknown> & { idempotencyKey: string }) => {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new StripeApiError(503, null, 'Stripe could not be reached');
    }
    const { idempotencyKey, ...request } = args;
    const body = JSON.stringify(request);
    const earlier = this.byKey.get(idempotencyKey);
    if (earlier) {
      if (earlier.body !== body) {
        this.refused += 1;
        throw new StripeApiError(400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters');
      }
      return earlier.session;
    }
    this.created += 1;
    this.emails.push(String(request.customerEmail));
    const session = { id: `cs_${randomBytes(6).toString('hex')}`, url: `https://checkout.stripe.test/pay/${this.created}` };
    this.byKey.set(idempotencyKey, { body, session });
    return session;
  };
}

let stripe: IdempotentStripe;

beforeAll(async () => {
  const directory = new FakeDirectory();
  state.directory = directory;
  state.contactBook = new FakeContactBook(directory);
  fx = openStorefrontFixtures();
  tenant = await provisionCommerceTenant(fx, 'second-pay');
  host = (await createPublishedSite(fx, tenant.tgId, 'second-pay')).host;
  await initCompany(booksScope(tenant.db, tenant.tgId, DEMO_COMPANY_ID, { recipients: directory }), { taxStatus: 'regular', invoiceNext: 1000 });
}, PROVISIONING_TIMEOUT);

afterAll(async () => {
  await fx?.close();
});

beforeEach(async () => {
  stripe = new IdempotentStripe();
  state.stripe = stripe as unknown as StripeApi;
  const fake = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID']) vi.stubEnv(key, fake('test'));
  await startOnboarding(tenant.db, state.stripe as StripeApi, { tenantId: DEMO_COMPANY_ID, country: 'DE', refreshUrl: 'r', returnUrl: 'r' });
  await refreshAccount(tenant.db, state.stripe as StripeApi, DEMO_COMPANY_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const buyer = (overrides: Record<string, unknown> = {}) => ({
  name: 'Alex Example',
  email: 'alex@example.com',
  addressLine1: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
  ...overrides,
});

function request(path: string, body: unknown): Request {
  return new Request(`http://${host}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host }, body: JSON.stringify(body) });
}

async function stripeOrder(): Promise<string> {
  const seeded = await seedBuyableProduct(tenant.db, { title: `P-${randomUUID().slice(0, 6)}`, handle: `p-${randomUUID()}`, amountCents: 1000, stocked: 5 });
  const res = await placeOrder(request('/api/commerce/orders', { lines: [{ variantId: seeded.variantId, quantity: 1 }] }));
  const body = (await res.json()) as { orderId: string; provider: string };
  expect(body.provider).toBe('stripe');
  return body.orderId;
}

async function payOrder(orderId: string, body: unknown) {
  const res = await pay(request(`/api/commerce/orders/${orderId}/pay`, body), { params: Promise.resolve({ orderId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function paymentOf(orderId: string) {
  return tenant.db
    .selectFrom('order_payment')
    .select(['status', 'buyer', 'checkout_request'])
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

describe('pressing Pay again on a Stripe order', () => {
  it('forward and resume: the first click fixes the request; later, from another page, the same session answers', async () => {
    const orderId = await stripeOrder();
    const first = await payOrder(orderId, { buyer: buyer(), returnPath: '/shop' });
    expect(first).toMatchObject({ status: 200, body: { status: 'redirect', redirectUrl: 'https://checkout.stripe.test/pay/1' } });
    expect(await paymentOf(orderId)).toMatchObject({
      status: 'pending',
      buyer: { email: 'alex@example.com' },
      checkout_request: { buyerEmail: 'alex@example.com', returnUrl: `https://${host}/shop`, confirmed: true },
    });

    // Back from Stripe five minutes later, on another page: the clock and the page moved, the request did not.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
    const again = await payOrder(orderId, { buyer: buyer(), returnPath: '/cart?step=pay' });
    expect(again).toEqual(first);
    // A bare click (no buyer sent) is the same click.
    expect(await payOrder(orderId, {})).toEqual(first);
    expect(stripe.created).toBe(1);
    expect(stripe.refused).toBe(0);
  });

  it('backtrack: another buyer on an order already in payment is refused, the first stays, Stripe is not asked', async () => {
    const orderId = await stripeOrder();
    await payOrder(orderId, { buyer: buyer() });
    const before = await paymentOf(orderId);

    const other = await payOrder(orderId, { buyer: buyer({ email: 'someone.else@example.com', name: 'Sam Other' }) });
    expect(other).toMatchObject({ status: 409, body: { error: { code: 'buyer_fixed', message: expect.stringContaining('Nothing has been charged') } } });
    expect(await paymentOf(orderId)).toEqual(before);
    expect(stripe.created).toBe(1);
    expect(stripe.refused).toBe(0);
    // The first buyer can still pay it.
    expect(await payOrder(orderId, { buyer: buyer() })).toMatchObject({ status: 200, body: { redirectUrl: 'https://checkout.stripe.test/pay/1' } });
  });

  it('a buyer refused before any session (outside Germany) fixes nothing; the corrected buyer does', async () => {
    const orderId = await stripeOrder();
    expect(await payOrder(orderId, { buyer: buyer({ country: 'AT', postalCode: '1010', city: 'Wien' }) })).toMatchObject({ status: 422 });
    expect((await paymentOf(orderId)).checkout_request).toBeNull();
    expect(await payOrder(orderId, { buyer: buyer() })).toMatchObject({ status: 200, body: { status: 'redirect' } });
  });

  it('re-entry: two clicks at once agree on one request and one session', async () => {
    const orderId = await stripeOrder();
    const [a, b] = await Promise.all([
      payOrder(orderId, { buyer: buyer(), returnPath: '/a' }),
      payOrder(orderId, { buyer: buyer(), returnPath: '/b' }),
    ]);
    expect(a).toEqual(b);
    expect(stripe.created).toBe(1);
    expect(stripe.refused).toBe(0);
  });

  it('backtrack: Stripe failing on the first click locks no typo in; the corrected buyer is the one the session gets', async () => {
    const orderId = await stripeOrder();
    stripe.failNext = 1;
    const typo = buyer({ email: 'alex@exmaple.com' });
    expect((await payOrder(orderId, { buyer: typo })).status).toBe(500);
    // Written before Stripe was asked, and not confirmed: nothing is made out to it.
    expect((await paymentOf(orderId)).checkout_request).toMatchObject({ buyerEmail: 'alex@exmaple.com', confirmed: false });

    const corrected = await payOrder(orderId, { buyer: buyer() });
    expect(corrected).toMatchObject({ status: 200, body: { status: 'redirect' } });
    expect(stripe.emails).toEqual(['alex@example.com']);
    expect(await paymentOf(orderId)).toMatchObject({
      buyer: { email: 'alex@example.com' },
      checkout_request: { buyerEmail: 'alex@example.com', confirmed: true },
    });
    // Now confirmed: the typo can no longer come back.
    expect(await payOrder(orderId, { buyer: typo })).toMatchObject({ status: 409, body: { error: { code: 'buyer_fixed' } } });
  });

  it('two clicks at once with different buyers: one session, and the order holds the buyer it is made out to', async () => {
    const orderId = await stripeOrder();
    const answers = await Promise.all([
      payOrder(orderId, { buyer: buyer() }),
      payOrder(orderId, { buyer: buyer({ name: 'Bea Other', email: 'bea@example.com' }) }),
    ]);
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(stripe.created).toBe(1);
    const row = await paymentOf(orderId);
    expect(row.checkout_request).toMatchObject({ buyerEmail: stripe.emails[0], confirmed: true });
    expect((row.buyer as { email: string }).email).toBe(stripe.emails[0]);
  });

  it('the database lets an unconfirmed request change, and fixes the request and its buyer once confirmed (BK018)', async () => {
    const orderId = await stripeOrder();
    const update = (set: Record<string, unknown>) =>
      tenant.db.updateTable('order_payment').set(set).where('order_id', '=', orderId).execute();
    await update({ checkout_request: toJsonb({ buyerEmail: 'a@example.com', returnUrl: 'https://a.example/', confirmed: false }) });
    await expect(update({ buyer: toJsonb(buyer({ email: 'b@example.com' })) })).resolves.toBeDefined();
    await expect(update({ checkout_request: null })).resolves.toBeDefined();
  });

  it('the database fixes the request and its buyer once set (BK018)', async () => {
    const orderId = await stripeOrder();
    await payOrder(orderId, { buyer: buyer() });
    const update = (set: Record<string, unknown>) =>
      tenant.db.updateTable('order_payment').set(set).where('order_id', '=', orderId).execute();
    expect(await rejectionCode(update({ buyer: toJsonb(buyer({ email: 'x@example.com' })) }))).toBe('BK018');
    expect(await rejectionCode(update({ checkout_request: toJsonb({ buyerEmail: 'x@example.com', returnUrl: 'https://x.example/' }) }))).toBe('BK018');
    expect(await rejectionCode(update({ checkout_request: null }))).toBe('BK018');
  });
});
