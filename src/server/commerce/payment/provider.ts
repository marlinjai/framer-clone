// src/server/commerce/payment/provider.ts
//
// The server-side payment provider seam (docs/plans/2026-10-25-catalogue-design.md, "Checkout, payment and
// receipt"; the parent plan keeps the payment layer provider-neutral). A provider starts a payment for an
// order and refunds one; what happened arrives as a PaymentEvent (a webhook for a real provider, an
// in-process call for the demo one) and goes through ONE handler, payments.ts handlePaymentEvent, whatever
// the provider. Money is integer minor units throughout.

export type ProviderId = 'demo' | 'stripe';

/** What a provider reports, normalised. `eventId` is the provider's own id: the handler records it once. */
export interface PaymentEvent {
  provider: ProviderId;
  eventId: string;
  type: 'payment_succeeded' | 'payment_failed' | 'checkout_cancelled' | 'checkout_expired';
  tenantId: string;
  orderId: string;
  /** The provider's payment reference (a Stripe PaymentIntent id, a demo transaction id). */
  providerPaymentId?: string;
  /** The amount the provider charged, minor units (checked against the payment on success). */
  amount?: number;
  currency?: string;
  /** A provider failure code, kept on the payment (a decline reason). */
  failureCode?: string;
}

/** What starting a payment answers: the provider reference, and for a hosted page where to send the buyer. */
export interface StartedPayment {
  providerPaymentId: string;
  redirectUrl?: string;
}

export interface StartPaymentArgs {
  tenantId: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  currency: string;
  /** The platform fee recorded on the payment (1%, minor units). */
  applicationFeeAmount: number;
  buyerEmail: string;
  /** Where a hosted checkout returns the buyer (success and cancel). */
  returnUrl?: string;
  /** The company's connected account (Stripe Connect); absent for the demo provider. */
  connectedAccountId?: string;
  /** Demo only: the provider declines. A real provider ignores it. */
  simulateDecline?: boolean;
}

export interface PaymentProvider {
  readonly id: ProviderId;
  /**
   * Start a payment. The demo provider decides at once and reports through `emit`; a hosted provider answers
   * a redirect and reports later through its webhook.
   */
  start(args: StartPaymentArgs, emit: (event: PaymentEvent) => Promise<void>): Promise<StartedPayment>;
  /** Refund a payment in full (the platform fee returns with it). Answers the provider's refund id. */
  refund(args: { providerPaymentId: string; amount: number; connectedAccountId?: string }): Promise<{ refundId: string }>;
}

/** A short random reference for the demo provider (no network, no money). */
function demoReference(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

/**
 * The demo provider: moves no money. It decides at once (declining on request, so the unhappy path can be
 * shown) and reports the outcome through the same event handler a real webhook uses.
 */
export const demoProvider: PaymentProvider = {
  id: 'demo',
  async start(args, emit) {
    if (!Number.isInteger(args.amount) || args.amount <= 0) {
      throw new Error(`demo provider: invalid amount ${args.amount}`);
    }
    const providerPaymentId = demoReference('demo_pi');
    await emit({
      provider: 'demo',
      eventId: demoReference('demo_evt'),
      type: args.simulateDecline ? 'payment_failed' : 'payment_succeeded',
      tenantId: args.tenantId,
      orderId: args.orderId,
      providerPaymentId,
      amount: args.amount,
      currency: args.currency,
      failureCode: args.simulateDecline ? 'card_declined' : undefined,
    });
    return { providerPaymentId };
  },
  async refund() {
    return { refundId: demoReference('demo_re') };
  },
};
