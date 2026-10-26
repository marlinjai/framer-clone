// src/server/commerce/payment/stripe/__tests__/stripe.test.ts
//
// The Stripe pieces that need no database: the webhook signature (valid, wrong secret, stale, malformed,
// a rotated second signature), what a delivery says, the form encoding, the configuration (placeholders read
// as "not configured"), the OAuth state (bound to the company, signed, expiring) and the shape of the HTTPS
// requests (direct charges on the connected account, the fee, idempotency keys). All data is synthetic;
// secrets are built at run time.

import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { formEncode, httpStripeApi, isStripeTestMode, stripeConfig, StripeApiError, type StripeConfig } from '../client';
import { oauthState, oauthUrl, readOauthState } from '../connect';
import { readStripeDelivery, signStripePayload, StripeSignatureError, verifyStripeSignature } from '../webhook';

const fake = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const CONFIG: StripeConfig = { secretKey: fake('test-secret'), webhookSecret: fake('test-hook'), connectClientId: fake('test-client') };
const TENANT = '018f9c10-0000-7000-8000-00000000c0a1';
const TG = '018f9c10-0000-7000-8000-0000000014aa';

function delivery(type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ id: 'evt_1', type, account: 'acct_123', data: { object }, ...extra });
}

describe('the webhook signature', () => {
  const body = delivery('payment_intent.succeeded', {});
  const now = 1_800_000_000;

  it('accepts a body signed with the secret within the tolerance', () => {
    expect(() => verifyStripeSignature(body, signStripePayload(body, CONFIG.webhookSecret, now), CONFIG.webhookSecret, now + 10)).not.toThrow();
  });

  it('accepts when any of several signatures matches (a rotated secret)', () => {
    const good = signStripePayload(body, CONFIG.webhookSecret, now).split(',')[1];
    expect(() => verifyStripeSignature(body, `t=${now},v1=${'0'.repeat(64)},${good}`, CONFIG.webhookSecret, now)).not.toThrow();
  });

  it('refuses another secret, a changed body, a stale delivery and a malformed or missing header', () => {
    const header = signStripePayload(body, CONFIG.webhookSecret, now);
    const refuse = (b: string, h: string | null, at = now) =>
      expect(() => verifyStripeSignature(b, h, CONFIG.webhookSecret, at)).toThrow(StripeSignatureError);
    refuse(body, signStripePayload(body, fake('other'), now));
    refuse(`${body} `, header);
    refuse(body, header, now + 301);
    refuse(body, 'v1=abc');
    refuse(body, null);
  });
});

describe('what a delivery says', () => {
  const metadata = { order_id: 'order_1', tenant_id: TENANT, tenant_group_id: TG };

  it('a succeeded PaymentIntent is a payment_succeeded with the received amount, upper-case currency and its id', () => {
    expect(
      readStripeDelivery(delivery('payment_intent.succeeded', { id: 'pi_1', amount: 999, amount_received: 999, currency: 'eur', metadata })),
    ).toEqual({
      kind: 'payment',
      tenantGroupId: TG,
      accountId: 'acct_123',
      event: {
        provider: 'stripe',
        eventId: 'evt_1',
        type: 'payment_succeeded',
        tenantId: TENANT,
        orderId: 'order_1',
        providerPaymentId: 'pi_1',
        amount: 999,
        currency: 'EUR',
        failureCode: undefined,
      },
    });
  });

  it('a failed PaymentIntent carries the decline code; an expired session closes the order', () => {
    const failed = readStripeDelivery(
      delivery('payment_intent.payment_failed', { id: 'pi_2', currency: 'eur', metadata, last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } }),
    );
    expect(failed.kind === 'payment' && failed.event).toMatchObject({ type: 'payment_failed', failureCode: 'insufficient_funds' });
    const expired = readStripeDelivery(delivery('checkout.session.expired', { id: 'cs_1', metadata }));
    expect(expired.kind === 'payment' && expired.event).toMatchObject({ type: 'checkout_expired', providerPaymentId: undefined });
  });

  it('other events are ignored, and a payment event without the platform metadata is refused', () => {
    expect(readStripeDelivery(delivery('customer.created', {}))).toEqual({ kind: 'ignored', type: 'customer.created' });
    expect(() => readStripeDelivery(delivery('payment_intent.succeeded', { id: 'pi_3' }))).toThrow(/no order metadata/);
  });
});

describe('the Stripe client', () => {
  it('encodes nested parameters as Stripe expects', () => {
    expect(formEncode({ a: 1, b: { c: 'x y' }, l: [{ q: 1 }], skip: undefined })).toEqual(['a=1', 'b%5Bc%5D=x%20y', 'l%5B0%5D%5Bq%5D=1']);
  });

  it('reads placeholders and missing keys as not configured', () => {
    expect(stripeConfig({})).toBeNull();
    expect(
      stripeConfig({ STRIPE_SECRET_KEY: 'PLACEHOLDER_REPLACE_ME', STRIPE_WEBHOOK_SECRET: CONFIG.webhookSecret, STRIPE_CONNECT_CLIENT_ID: 'x' }),
    ).toBeNull();
    expect(
      stripeConfig({ STRIPE_SECRET_KEY: CONFIG.secretKey, STRIPE_WEBHOOK_SECRET: CONFIG.webhookSecret, STRIPE_CONNECT_CLIENT_ID: CONFIG.connectClientId }),
    ).toEqual(CONFIG);
  });

  it('knows test keys from live ones, so the owner is never promised real payments in a sandbox', () => {
    // Prefixes joined at run time: no vendor-shaped literal in the source.
    const key = (mode: string, kind = 'sk') => `${kind}_${mode}_${randomBytes(12).toString('hex')}`;
    expect(isStripeTestMode({ ...CONFIG, secretKey: key('test') })).toBe(true);
    expect(isStripeTestMode({ ...CONFIG, secretKey: key('test', 'rk') })).toBe(true);
    expect(isStripeTestMode({ ...CONFIG, secretKey: key('live') })).toBe(false);
  });

  it('a checkout session is a direct charge on the connected account with the fee and an idempotency key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.example/cs_1' }), { status: 200 }));
    const api = httpStripeApi(CONFIG, fetchImpl as unknown as typeof fetch);
    const session = await api.createCheckoutSession({
      accountId: 'acct_123',
      orderId: 'order_1',
      orderNumber: 'ORD-000001',
      tenantGroupId: TG,
      tenantId: TENANT,
      amount: 999,
      currency: 'EUR',
      applicationFeeAmount: 10,
      customerEmail: 'alex@example.com',
      successUrl: 'https://shop.example/?checkout=paid',
      cancelUrl: 'https://shop.example/?checkout=cancelled',
      expiresAt: 1_800_000_000,
      idempotencyKey: 'checkout:order_1',
    });
    expect(session.url).toBe('https://checkout.example/cs_1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = init.headers as Record<string, string>;
    expect(headers['stripe-account']).toBe('acct_123');
    expect(headers['idempotency-key']).toBe('checkout:order_1');
    const params = new URLSearchParams(String(init.body));
    expect(params.get('payment_intent_data[application_fee_amount]')).toBe('10');
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('999');
    expect(params.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(params.get('payment_intent_data[metadata][tenant_group_id]')).toBe(TG);
    expect(params.get('expires_at')).toBe('1800000000');
  });

  it('a refund returns the fee too, on the connected account; an error carries Stripe code, not the request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 're_1' }), { status: 200 }));
    await httpStripeApi(CONFIG, fetchImpl as unknown as typeof fetch).createRefund({
      accountId: 'acct_123',
      paymentIntentId: 'pi_1',
      idempotencyKey: 'refund:pi_1',
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get('refund_application_fee')).toBe('true');
    expect((init.headers as Record<string, string>)['stripe-account']).toBe('acct_123');

    const failing = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'resource_missing', message: 'No such payment_intent' } }), { status: 404 }));
    const err = await httpStripeApi(CONFIG, failing as unknown as typeof fetch)
      .createRefund({ accountId: 'acct_123', paymentIntentId: 'pi_x', idempotencyKey: 'refund:pi_x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeApiError);
    expect(err).toMatchObject({ status: 404, stripeCode: 'resource_missing' });
  });
});

describe('the OAuth state', () => {
  it('names its company, signed and expiring after 15 minutes', () => {
    const now = 1_800_000_000_000;
    const state = oauthState(CONFIG, TENANT, now);
    expect(readOauthState(CONFIG, state, now + 60_000)).toBe(TENANT);
    expect(readOauthState(CONFIG, state, now + 16 * 60_000)).toBeNull();
    expect(readOauthState({ ...CONFIG, secretKey: fake('other') }, state, now)).toBeNull();
    const [, expires, sig] = state.split('.');
    expect(readOauthState(CONFIG, `018f9c10-0000-7000-8000-00000000c0b2.${expires}.${sig}`, now)).toBeNull();
    expect(readOauthState(CONFIG, 'garbage', now)).toBeNull();
  });

  it('the authorize address carries the client id, the state and the return address', () => {
    const url = new URL(oauthUrl(CONFIG, 'state-1', 'https://app.example/api/payments/stripe/oauth/callback'));
    expect(url.origin).toBe('https://connect.stripe.com');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.connectClientId);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toBe('read_write');
  });
});
