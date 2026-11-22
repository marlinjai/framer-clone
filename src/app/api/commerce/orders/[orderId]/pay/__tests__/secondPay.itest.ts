// src/app/api/commerce/orders/[orderId]/pay/__tests__/secondPay.itest.ts
//
// Pressing Pay again on a Stripe order (the money review of 2026-11-02, finding 5, and slice B7 of
// docs/plans/2026-11-02-shop-backbone.md). The first click pins the checkout session (its end, return address and buyer)
// before Stripe is asked, under the idempotency key `checkout:<orderId>`; once Stripe answered, the session id is stored
// and every later click reads that session instead of creating it again. The fake Stripe below keeps Stripe's rule (one
// key, one request; a repeat replays the first answer, another request is refused), so a request that drifts between
// clicks fails here as it would there. Through the real order and pay routes on Postgres:
//
//   - forward: the first click pins, creates, stores and redirects;
//   - resume: a buyer back from Stripe presses Pay again, later and from another page, and gets the same session, read
//     from Stripe; a click after Stripe took the money answers paid, one after the session expired closes the order;
//   - backtrack: another buyer after the pin is refused (409 buyer_fixed), Stripe is not asked; a buyer refused before
//     the pin fixes nothing;
//   - re-entry: two clicks at once agree on one session; Stripe unreachable answers 503 and the next click goes through;
//     a create Stripe refused closes the order; a key Stripe holds for another request answers 409 checkout_pending.
// The database's own refusals (BK018) are tested in src/server/commerce/payment/__tests__/checkoutSession.itest.ts.
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
  private readonly byKey = new Map<string, { body: string; answer: { id: string; url: string } | StripeApiError }>();
  readonly sessions = new Map<string, { id: string; status: 'open' | 'complete' | 'expired'; paid: boolean; url: string; amount: number; currency: string }>();
  created = 0;
  refused = 0;
  retrieved = 0;
  /** The next calls get no answer, before anything is stored under the key. */
  failNext = 0;
  /** The next create is refused with an answered 400, which Stripe stores under the key. */
  refuseNext = 0;
  /** The email of every session created, in order. */
  emails: string[] = [];
  createAccount = async () => ({ id: `acct_${randomBytes(6).toString('hex')}`, charges_enabled: false, details_submitted: false });
  retrieveAccount = async (id: string) => ({ id, charges_enabled: true, details_submitted: true });
  createAccountLink = async () => ({ url: 'https://connect.stripe.test/setup' });
  /** Another request already stored under the order's key (a session the build before made). */
  holdKey(orderId: string) {
    this.byKey.set(`checkout:${orderId}`, { body: 'an earlier request', answer: { id: 'cs_earlier', url: 'https://checkout.stripe.test/earlier' } });
  }
  createCheckoutSession = async (args: Record<string, unknown> & { idempotencyKey: string }) => {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new StripeApiError(0, null, 'Stripe gave no answer', false);
    }
    const { idempotencyKey, ...request } = args;
    // A click's abort signal is not sent to Stripe: it is left out of what counts as the request.
    const body = JSON.stringify({ ...request, signal: undefined });
    const earlier = this.byKey.get(idempotencyKey);
    if (earlier) {
      if (earlier.body !== body) {
        this.refused += 1;
        throw new StripeApiError(400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters', true, 'idempotency_error');
      }
      if (earlier.answer instanceof StripeApiError) throw earlier.answer;
      return earlier.answer;
    }
    if (this.refuseNext > 0) {
      this.refuseNext -= 1;
      const refusal = new StripeApiError(400, 'parameter_invalid', 'refused', true, 'invalid_request_error');
      this.byKey.set(idempotencyKey, { body, answer: refusal });
      throw refusal;
    }
    this.created += 1;
    this.emails.push(String(request.customerEmail));
    const session = { id: `cs_${randomBytes(6).toString('hex')}`, url: `https://checkout.stripe.test/pay/${this.created}` };
    this.sessions.set(session.id, { ...session, status: 'open', paid: false, amount: Number(request.amount), currency: String(request.currency).toLowerCase() });
    this.byKey.set(idempotencyKey, { body, answer: session });
    return session;
  };
  retrieveCheckoutSession = async ({ sessionId }: { sessionId: string }) => {
    this.retrieved += 1;
    const session = this.sessions.get(sessionId);
    if (!session) throw new StripeApiError(404, 'resource_missing', 'No such checkout session', true, 'invalid_request_error');
    return {
      id: session.id,
      status: session.status,
      payment_status: session.paid ? ('paid' as const) : ('unpaid' as const),
      url: session.status === 'open' ? session.url : null,
      amount_total: session.amount,
      currency: session.currency,
      payment_intent: session.paid ? `pi_${session.id}` : null,
    };
  };
  only() {
    const all = [...this.sessions.values()];
    expect(all).toHaveLength(1);
    return all[0];
  }
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
    .select(['status', 'buyer', 'provider_session_id', 'session_return_url', 'session_expires_at', 'expires_at'])
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

describe('pressing Pay again on a Stripe order', () => {
  it('forward and resume: the first click pins and stores; later, from another page, the same session answers', async () => {
    const orderId = await stripeOrder();
    const first = await payOrder(orderId, { buyer: buyer(), returnPath: '/shop' });
    expect(first).toMatchObject({ status: 200, body: { status: 'redirect', redirectUrl: 'https://checkout.stripe.test/pay/1' } });
    const pinned = await paymentOf(orderId);
    expect(pinned).toMatchObject({
      status: 'pending',
      buyer: { email: 'alex@example.com' },
      provider_session_id: stripe.only().id,
      session_return_url: `https://${host}/shop`,
    });
    expect(pinned.expires_at.getTime() - pinned.session_expires_at!.getTime()).toBe(5 * 60 * 1000);

    // Back from Stripe five minutes later, on another page: the clock and the page moved, the request did not.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
    const again = await payOrder(orderId, { buyer: buyer(), returnPath: '/cart?step=pay' });
    expect(again).toEqual(first);
    // A bare click (no buyer sent) is the same click.
    expect(await payOrder(orderId, {})).toEqual(first);
    expect(stripe.created).toBe(1);
    expect(stripe.refused).toBe(0);
    expect(stripe.retrieved).toBe(2);
  });

  it('resume: a click after Stripe took the money answers paid; one after the session expired closes the order', async () => {
    const paidOrder = await stripeOrder();
    await payOrder(paidOrder, { buyer: buyer() });
    const session = stripe.only();
    Object.assign(session, { status: 'complete', paid: true });
    expect(await payOrder(paidOrder, {})).toEqual({ status: 200, body: { status: 'paid' } });
    expect((await paymentOf(paidOrder)).status).toBe('paid');
    expect(await payOrder(paidOrder, {})).toMatchObject({ status: 409, body: { error: { code: 'payment_closed' } } });

    stripe.sessions.clear();
    const expiredOrder = await stripeOrder();
    await payOrder(expiredOrder, { buyer: buyer() });
    Object.assign(stripe.only(), { status: 'expired' });
    expect(await payOrder(expiredOrder, {})).toMatchObject({ status: 409, body: { error: { code: 'payment_closed', status: 'expired' } } });
    expect((await paymentOf(expiredOrder)).status).toBe('expired');
  });

  it('backtrack: another buyer after the pin is refused, the first stays, Stripe is not asked', async () => {
    const orderId = await stripeOrder();
    await payOrder(orderId, { buyer: buyer() });
    const before = await paymentOf(orderId);

    const other = await payOrder(orderId, { buyer: buyer({ email: 'someone.else@example.com', name: 'Sam Other' }) });
    expect(other).toMatchObject({ status: 409, body: { error: { code: 'buyer_fixed', message: expect.stringContaining('Nothing has been charged') } } });
    expect(await paymentOf(orderId)).toEqual(before);
    expect(stripe.created).toBe(1);
    expect(stripe.refused).toBe(0);
    expect(stripe.retrieved).toBe(0);
    // The first buyer can still pay it.
    expect(await payOrder(orderId, { buyer: buyer() })).toMatchObject({ status: 200, body: { redirectUrl: 'https://checkout.stripe.test/pay/1' } });
  });

  it('a buyer refused before any session (outside Germany) pins nothing; the corrected buyer does', async () => {
    const orderId = await stripeOrder();
    expect(await payOrder(orderId, { buyer: buyer({ country: 'AT', postalCode: '1010', city: 'Wien' }) })).toMatchObject({ status: 422 });
    expect((await paymentOf(orderId)).session_expires_at).toBeNull();
    expect(await payOrder(orderId, { buyer: buyer() })).toMatchObject({ status: 200, body: { status: 'redirect' } });
  });

  it('re-entry: two clicks at once agree on one session', async () => {
    const orderId = await stripeOrder();
    const [a, b] = await Promise.all([
      payOrder(orderId, { buyer: buyer(), returnPath: '/a' }),
      payOrder(orderId, { buyer: buyer(), returnPath: '/b' }),
    ]);
    expect(a).toEqual(b);
    expect(stripe.created).toBe(1);
    expect(stripe.refused).toBe(0);
  });

  it('two clicks at once with different buyers: one session, and the order holds the buyer it is made out to', async () => {
    const orderId = await stripeOrder();
    const answers = await Promise.all([
      payOrder(orderId, { buyer: buyer() }),
      payOrder(orderId, { buyer: buyer({ name: 'Bea Other', email: 'bea@example.com' }) }),
    ]);
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(answers.filter((a) => a.status === 409 && (a.body.error as { code: string }).code === 'buyer_fixed')).toHaveLength(1);
    expect(stripe.created).toBe(1);
    expect(((await paymentOf(orderId)).buyer as { email: string }).email).toBe(stripe.emails[0]);
  });

  it('Stripe unreachable: 503, nothing charged, the pin stays with its buyer, and the next click goes through', async () => {
    const orderId = await stripeOrder();
    stripe.failNext = 1;
    expect(await payOrder(orderId, { buyer: buyer() })).toMatchObject({ status: 503, body: { error: { code: 'checkout_unavailable' } } });
    expect(await paymentOf(orderId)).toMatchObject({ status: 'pending', provider_session_id: null, buyer: { email: 'alex@example.com' } });
    // Stripe may have made the session under that email: the pin keeps it, and another buyer is refused.
    expect(await payOrder(orderId, { buyer: buyer({ email: 'alex@example.org' }) })).toMatchObject({ status: 409, body: { error: { code: 'buyer_fixed' } } });
    expect(await payOrder(orderId, {})).toMatchObject({ status: 200, body: { status: 'redirect' } });
    expect(stripe.emails).toEqual(['alex@example.com']);
  });

  it('a create Stripe refused closes the order (409 payment_closed); a key held for another request answers 409 checkout_pending', async () => {
    const refused = await stripeOrder();
    stripe.refuseNext = 1;
    expect(await payOrder(refused, { buyer: buyer() })).toMatchObject({ status: 409, body: { error: { code: 'payment_closed', status: 'cancelled' } } });
    expect((await paymentOf(refused)).status).toBe('cancelled');

    const held = await stripeOrder();
    stripe.holdKey(held);
    expect(await payOrder(held, { buyer: buyer() })).toMatchObject({ status: 409, body: { error: { code: 'checkout_pending' } } });
    expect((await paymentOf(held)).status).toBe('pending');
  });
});
