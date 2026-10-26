// StorefrontPaymentGateway: pays an order through the storefront's server (POST
// /api/commerce/orders/<orderId>/pay). The server runs the provider (the demo provider today, which moves NO
// money) and the same handler a real provider's webhook uses, so a paid order gets its receipt in the shop
// owner's Books. The browser never decides that an order is paid; it shows what the server answered.
//
// Answers, mapped to the PaymentResult the checkout renders:
//   200 paid                    -> ok, with the receipt number when it is already issued
//   402 payment_declined        -> declined (the order is closed: the checkout starts a new one)
//   409 payment_closed          -> closed (paid or closed elsewhere, or expired: check out again)
//   422 buyer_required / 400    -> invalid (the buyer's details are missing or malformed)
//   anything else, or no answer -> gateway_error (retryable)

import type { PaymentGateway, PaymentRequest, PaymentResult } from './types';

interface ErrorBody {
  error?: { code?: string; message?: string };
}

async function errorOf(res: Response): Promise<ErrorBody['error']> {
  try {
    return ((await res.json()) as ErrorBody).error;
  } catch {
    return undefined;
  }
}

export class StorefrontPaymentGateway implements PaymentGateway {
  readonly id = 'demo';
  readonly isDemo = true;

  constructor(private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  async authorize(request: PaymentRequest): Promise<PaymentResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`/api/commerce/orders/${encodeURIComponent(request.orderId)}/pay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ buyer: request.buyer, simulateDecline: request.simulateDecline ?? false }),
      });
    } catch (err) {
      return { ok: false, code: 'gateway_error', message: err instanceof Error ? err.message : 'the shop did not answer' };
    }
    if (res.ok) {
      const body = (await res.json()) as { status: string; receipt: { number: string | null } | null };
      return { ok: true, provider: this.id, transactionId: request.orderId, receiptNumber: body.receipt?.number ?? null };
    }
    const error = await errorOf(res);
    if (res.status === 402) {
      return { ok: false, code: 'declined', message: error?.message ?? 'the card was declined' };
    }
    if (res.status === 409) {
      return { ok: false, code: 'closed', message: error?.message ?? 'the order no longer takes a payment' };
    }
    if (res.status === 422 || res.status === 400) {
      return { ok: false, code: 'invalid', message: 'check the name, email and address: the receipt is made out to them' };
    }
    return { ok: false, code: 'gateway_error', message: `the payment could not be completed (${res.status}), try again` };
  }
}
