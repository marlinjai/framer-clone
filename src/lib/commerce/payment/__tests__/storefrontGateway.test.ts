// src/lib/commerce/payment/__tests__/storefrontGateway.test.ts
//
// The server-backed gateway maps the pay route's answers to the result the checkout renders, and sends the
// buyer and the decline switch, never an amount (the server owns the money).

import { describe, expect, it, vi } from 'vitest';

import { StorefrontPaymentGateway } from '../storefrontGateway';

const BUYER = {
  name: 'Alex Example',
  email: 'alex@example.com',
  addressLine1: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
};

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

const request = { orderId: 'order 1', amountCents: 1190, currency: 'EUR', buyer: BUYER };

describe('StorefrontPaymentGateway', () => {
  it('pays through the server route with the buyer and no amount, and answers the receipt number', async () => {
    const fetchImpl = answer(200, { status: 'paid', receipt: { documentId: 'd1', number: '1000' }, receiptError: null });
    const result = await new StorefrontPaymentGateway(fetchImpl as unknown as typeof fetch).authorize(request);
    expect(result).toEqual({ ok: true, provider: 'demo', transactionId: 'order 1', receiptNumber: '1000' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/commerce/orders/order%201/pay');
    expect(JSON.parse(String(init.body))).toEqual({ buyer: BUYER, simulateDecline: false });
  });

  it('a receipt still being issued is no failure', async () => {
    const fetchImpl = answer(200, { status: 'paid', receipt: null, receiptError: 'RECIPIENT_UNAVAILABLE' });
    expect(await new StorefrontPaymentGateway(fetchImpl as unknown as typeof fetch).authorize(request)).toMatchObject({
      ok: true,
      receiptNumber: null,
    });
  });

  it.each([
    [402, { error: { code: 'payment_declined', message: 'the card was declined' } }, 'declined'],
    [409, { error: { code: 'payment_closed', message: 'the order is expired' } }, 'closed'],
    [422, { error: { code: 'buyer_required', message: 'x' } }, 'invalid'],
    [400, { error: { code: 'bad_body', message: 'x' } }, 'invalid'],
    [500, { error: { code: 'commerce_payment_failed', message: 'x' } }, 'gateway_error'],
  ])('maps %i to %s', async (status, body, code) => {
    const result = await new StorefrontPaymentGateway(answer(status, body) as unknown as typeof fetch).authorize(request);
    expect(result).toMatchObject({ ok: false, code });
  });

  it('a network failure is a retryable gateway error', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await new StorefrontPaymentGateway(failing as unknown as typeof fetch).authorize(request)).toEqual({
      ok: false,
      code: 'gateway_error',
      message: 'offline',
    });
  });
});
