// src/server/commerce/payment/provider.ts
//
// The server-side payment provider seam (docs/plans/2026-10-25-catalogue-design.md, "Checkout, payment and
// receipt"; the parent plan keeps the payment layer provider-neutral). A provider starts a payment for an
// order and refunds one; what happened arrives as a PaymentEvent (a webhook for a real provider, an
// in-process call for the demo one) and goes through ONE handler, payments.ts handlePaymentEvent, whatever
// the provider. Money is integer minor units throughout.

import { MAX_ORDER_INTEGER } from '@/lib/commerce/dto';

export type ProviderId = 'demo' | 'stripe';

/**
 * The most Stripe takes in one charge, in the currency's minor unit, for a payment
 * method other than a card: its `amount` holds at most eight digits (99999999, that
 * is 999,999.99 EUR) in every currency but the few in STRIPE_MAX_CHARGE_BY_CURRENCY
 * (https://docs.stripe.com/currencies, "Maximum charge amounts", read 2026-11-04).
 * Cards allow more (up to twelve digits, nine for American Express), but the hosted
 * checkout may offer a buyer any method the account has, so the eight digits are
 * what every payment can take. A larger amount is refused when the payment starts,
 * after the order already holds its stock.
 */
export const STRIPE_MAX_CHARGE = 99_999_999;

/** The currencies Stripe allows more digits in (ISO 4217, uppercase), minor units. */
export const STRIPE_MAX_CHARGE_BY_CURRENCY: Readonly<Record<string, number>> = {
  IDR: 999_999_999_999,
  COP: 9_999_999_999,
  INR: 999_999_999,
};

/**
 * The largest order total `provider` takes in one payment of `currency`, minor
 * units, and never more than an order stores (MAX_ORDER_INTEGER). createOrder
 * refuses an order over it before anything is written (a 422 order_too_large), so
 * no order holds stock for a payment that cannot succeed. The demo provider moves
 * no money, so only what an order stores bounds it.
 */
export function maxChargeAmount(provider: ProviderId, currency: string): number {
  if (provider !== 'stripe') return MAX_ORDER_INTEGER;
  return Math.min(STRIPE_MAX_CHARGE_BY_CURRENCY[currency.toUpperCase()] ?? STRIPE_MAX_CHARGE, MAX_ORDER_INTEGER);
}

/**
 * The least Stripe takes in one charge, in the currency's minor unit: 0.50 in
 * most currencies (https://docs.stripe.com/currencies, "Minimum charge amounts",
 * read 2026-11-04), so the fee never exceeds the charge. The currencies with a
 * different minimum are in STRIPE_MIN_CHARGE_BY_CURRENCY. Stripe applies the
 * minimum of the account's settlement currency: a charge in another currency must
 * still reach it after conversion, which no table here can know, so an unlisted
 * currency is held to 50 minor units, the most common minimum. A smaller amount is
 * refused when the payment starts, after the order already holds its stock.
 */
export const STRIPE_MIN_CHARGE = 50;

/**
 * The currencies whose Stripe minimum is not 50 minor units (ISO 4217, uppercase),
 * minor units. HUF is charged with two decimals (175.00 HUF is 17500); JPY and KRW
 * are zero-decimal and their 50 is the default, so they are not listed.
 */
export const STRIPE_MIN_CHARGE_BY_CURRENCY: Readonly<Record<string, number>> = {
  AED: 200,
  CZK: 1_500,
  DKK: 250,
  GBP: 30,
  HKD: 400,
  HUF: 17_500,
  MXN: 1_000,
  MYR: 200,
  NOK: 300,
  PLN: 200,
  RON: 200,
  SEK: 300,
  THB: 1_000,
};

/**
 * The smallest order total `provider` takes in one payment of `currency`, minor
 * units. createOrder refuses a paid order below it before anything is written (a
 * 422 order_too_small), so no order holds stock for a payment that cannot start.
 * A free order (total 0) opens no payment and is not held to it. The demo provider
 * moves no money, so it has no minimum (0).
 */
export function minChargeAmount(provider: ProviderId, currency: string): number {
  if (provider !== 'stripe') return 0;
  return STRIPE_MIN_CHARGE_BY_CURRENCY[currency.toUpperCase()] ?? STRIPE_MIN_CHARGE;
}

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
  /**
   * Our own clock closes this payment, not a provider's word: the expiry job and the sweeps set it. Under the row lock
   * and before anything is recorded, the payment must be pending with its window over, otherwise nothing is written. A
   * provider's own `checkout_expired` never sets it.
   */
  requireDue?: true;
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
  /**
   * When the payment window closes. A hosted checkout ends a fixed time after it, never computed from the clock, so
   * a repeated start of one order sends the same request (stripe/connect.ts).
   */
  expiresAt?: Date;
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
