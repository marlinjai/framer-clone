// The payment gateway barrel + the provider seam.
//
// `getPaymentGateway()` is the ONE place that decides which provider the
// storefront uses. Today it always returns the FakePaymentGateway (the demo:
// simulated, no real money). To integrate a real provider later:
//
//   1. Implement `PaymentGateway` (./types.ts) against the provider, e.g. a
//      `StripePaymentGateway` whose `authorize` POSTs to a NEW server route
//      (`/api/commerce/payments`) that creates + confirms a Stripe PaymentIntent
//      for `amountCents` and returns the result. The provider SECRET key stays
//      server-side; the client SDK only ever holds the publishable key.
//   2. Return it from `getPaymentGateway()`, gated on config (e.g. a
//      `PAYMENTS_PROVIDER` env var), keeping the FakePaymentGateway as the
//      default so local dev / the demo still work without provider credentials.
//
// The checkout UI calls `getPaymentGateway().authorize(...)` and is otherwise
// provider-agnostic, so step 2 is the only change the storefront needs.
//
// REAL-PROVIDER ORDERING NOTE: the demo creates the order FIRST (server computes
// the authoritative total + reserves stock), then authorizes the payment for that
// exact total. A real integration would instead create the order as PENDING,
// create the PaymentIntent, confirm it, and let a provider webhook flip the order
// to PAID. The interface here is unchanged by that swap; only the order status
// lifecycle (a separate, deferred piece) changes.

import { FakePaymentGateway } from './fakeGateway';
import type { PaymentGateway } from './types';

export * from './types';
export { FakePaymentGateway, DEMO_PROVIDER_ID } from './fakeGateway';

/**
 * Resolve the active payment gateway. DEMO: always the FakePaymentGateway with a
 * small simulated latency so the checkout shows a realistic processing state.
 * This is the seam a real provider plugs into (see the file header).
 */
export function getPaymentGateway(): PaymentGateway {
  return new FakePaymentGateway({ latencyMs: 600 });
}
