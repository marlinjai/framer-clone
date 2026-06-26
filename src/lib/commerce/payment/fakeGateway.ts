// FakePaymentGateway: the DEMO payment provider.
//
// It SIMULATES an authorization entirely client-side and moves NO real money. It
// exists so the storefront checkout can run end to end (cart -> order ->
// "payment" -> confirmation) for the hosted demo, while leaving the real
// integration to a future adapter behind the same `PaymentGateway` interface (see
// ./types.ts, ./index.ts).
//
// It still behaves like a real gateway in the ways that matter for a faithful
// demo: it validates the amount (a non-positive / non-integer cents amount is an
// `invalid` failure, never a silent success), it can DECLINE on demand (the
// demo's "simulate a declined payment" toggle drives the failure path), and it
// returns a provider transaction reference on success that the confirmation
// surfaces. There is no network call and no secret key anywhere in this module.

import type {
  PaymentGateway,
  PaymentRequest,
  PaymentResult,
} from './types';

/** The provider id stamped on demo authorizations. */
export const DEMO_PROVIDER_ID = 'demo';

/** A short, dependency-free pseudo-id for the demo transaction reference. */
function demoTransactionId(): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `demo_txn_${rand}`;
}

export interface FakePaymentGatewayOptions {
  /**
   * Optional artificial latency (ms) so the demo shows a realistic "processing"
   * state. Defaults to 0 in tests (no injected delay) and a small value in the UI
   * factory. Kept injectable so tests stay instant and deterministic.
   */
  latencyMs?: number;
}

export class FakePaymentGateway implements PaymentGateway {
  readonly id = DEMO_PROVIDER_ID;
  readonly isDemo = true;

  private readonly latencyMs: number;

  constructor(options: FakePaymentGatewayOptions = {}) {
    this.latencyMs = Math.max(0, options.latencyMs ?? 0);
  }

  async authorize(request: PaymentRequest): Promise<PaymentResult> {
    // Validate the amount the same way a real gateway would reject a malformed
    // charge. A non-positive or non-integer cents amount is a programming error
    // (the authoritative total comes from the server order), surfaced as a loud
    // `invalid` failure rather than a fake success.
    if (!Number.isInteger(request.amountCents) || request.amountCents <= 0) {
      return {
        ok: false,
        code: 'invalid',
        message: `invalid amount: ${request.amountCents} cents`,
      };
    }
    if (!request.currency) {
      return { ok: false, code: 'invalid', message: 'currency is required' };
    }

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    // The demo decline path: the storefront's "simulate a declined payment"
    // toggle drives this so the unhappy branch is demoable and testable.
    if (request.simulateDecline) {
      return {
        ok: false,
        code: 'declined',
        message: 'Demo card declined. This is a simulated decline, no real charge was attempted.',
      };
    }

    return {
      ok: true,
      provider: this.id,
      transactionId: demoTransactionId(),
    };
  }
}
