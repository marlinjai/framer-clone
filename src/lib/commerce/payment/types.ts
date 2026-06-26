// The payment gateway seam.
//
// This is the ONE interface a checkout flow talks to when it needs money to
// change hands. The storefront's CheckoutButton authorizes a payment through a
// `PaymentGateway` and never imports a concrete provider directly, so swapping
// the demo gateway for a real provider (Stripe / Adyen / Stripe Connect) is an
// ADAPTER change behind `getPaymentGateway()` (see ./index.ts), not a rewrite of
// the checkout UI.
//
// DEMO STATUS: the only implementation today is the FakePaymentGateway
// (./fakeGateway.ts), which simulates an authorization client-side and moves NO
// real money. The interface is deliberately provider-agnostic: a real adapter
// would implement `authorize` by calling a server route that creates + confirms
// the provider's payment intent (the client SDK never holds the secret key).

/** The amount + context to authorize. Money is integer cents (never float). */
export interface PaymentRequest {
  /** The server-authored order this payment settles (the authoritative total
   *  is read from the created order, never from the client cart). */
  orderId: string;
  /** The authoritative amount to charge, in integer cents. */
  amountCents: number;
  /** ISO-4217 currency, uppercase (e.g. `EUR`). */
  currency: string;
  /**
   * DEMO-ONLY escape hatch: when true, the fake gateway returns a `declined`
   * result so the storefront's failure path is exercisable in the demo. A real
   * adapter ignores this field (the provider decides the outcome).
   */
  simulateDecline?: boolean;
}

/** A successful authorization: money is (notionally) captured. */
export interface PaymentSuccess {
  ok: true;
  /** The gateway id that authorized the payment (e.g. `demo`, later `stripe`). */
  provider: string;
  /** The provider transaction reference, surfaced on the order confirmation. */
  transactionId: string;
}

/** A failed authorization. `code` lets the UI distinguish a decline from a fault. */
export interface PaymentFailure {
  ok: false;
  /**
   * `declined`: the provider refused the payment (insufficient funds, fraud, the
   *   demo decline toggle). The visitor can retry with another method.
   * `invalid`: the request itself was malformed (e.g. a non-positive amount). A
   *   programming error surfaced loudly, never a silent success.
   * `gateway_error`: the gateway/network failed. Retryable.
   */
  code: 'declined' | 'invalid' | 'gateway_error';
  /** A human-readable message surfaced to the visitor (never swallowed). */
  message: string;
}

export type PaymentResult = PaymentSuccess | PaymentFailure;

/**
 * A payment provider. The storefront authorizes through this interface and never
 * couples to a concrete provider. `isDemo` lets the UI render the unmistakable
 * "this is a simulated payment, no real charge" labeling required while the only
 * implementation is the fake gateway.
 */
export interface PaymentGateway {
  /** A stable provider id (e.g. `demo`, later `stripe`). */
  readonly id: string;
  /**
   * True for a simulated gateway that moves no real money. The checkout UI MUST
   * render a clear demo banner whenever this is true, so a viewer is never misled
   * into thinking a real charge occurred.
   */
  readonly isDemo: boolean;
  /** Authorize (and, for the demo, notionally capture) the payment. */
  authorize(request: PaymentRequest): Promise<PaymentResult>;
}
