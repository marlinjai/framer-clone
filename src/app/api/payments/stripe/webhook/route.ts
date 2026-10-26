// src/app/api/payments/stripe/webhook/route.ts
//
// POST /api/payments/stripe/webhook: Stripe's deliveries for the platform's connected accounts
// (docs/plans/2026-10-25-catalogue-design.md, "Checkout, payment and receipt", item 4; slice 5).
//
//   1. The signature is verified against STRIPE_WEBHOOK_SECRET over the raw body (stripe/webhook.ts);
//      anything else is a 400 and changes nothing.
//   2. A payment event names its order, company and tenant group in the metadata the platform set on the
//      checkout session, and its connected account in the event: the account must be the company's own,
//      so a connected account can never settle another company's order.
//   3. The event goes through the one payment handler (payments.ts): recorded once, the order's state
//      moved, the stock released or re-reserved, a late payment without stock refunded.
//   4. Answers: 200 when handled, repeated, ignored or not ours to apply (Stripe stops retrying); 500 when
//      the payment stands but its receipt could not be issued yet, or on a fault, so Stripe delivers again
//      and the receipt is retried.
//
// No session and no company cookie: the platform's signature is the only authority here. UNPROVEN against
// Stripe itself (no Stripe account yet); tested against signed fixtures.

import { assertTenantGroupId } from '@marlinjai/tenant-db';

import { jsonError } from '@/lib/api/respond';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import { configuredStripeApi, paymentDeps } from '@/server/commerce/payment/deps';
import { handlePaymentEvent, PaymentMismatchError, UnknownPaymentError } from '@/server/commerce/payment/payments';
import { stripeConfig } from '@/server/commerce/payment/stripe/client';
import { readAccount } from '@/server/commerce/payment/stripe/connect';
import { readStripeDelivery, StripeSignatureError, verifyStripeSignature } from '@/server/commerce/payment/stripe/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function ignored(reason: string): Response {
  return Response.json({ received: true, ignored: reason });
}

export async function POST(req: Request): Promise<Response> {
  const config = stripeConfig();
  const api = configuredStripeApi();
  if (!config || !api) return jsonError('stripe_not_configured', 'Stripe is not configured on this platform', 503);

  const raw = await req.text();
  try {
    verifyStripeSignature(raw, req.headers.get('stripe-signature'), config.webhookSecret);
  } catch (err) {
    if (err instanceof StripeSignatureError) return jsonError('bad_signature', err.message, 400);
    throw err;
  }

  let delivery: ReturnType<typeof readStripeDelivery>;
  try {
    delivery = readStripeDelivery(raw);
  } catch (err) {
    // A payment event the platform did not create (no order metadata): not ours to apply.
    console.error('[stripe] a delivery without order metadata was ignored:', err);
    return ignored('no_order_metadata');
  }
  if (delivery.kind === 'ignored') return ignored(delivery.type || 'unknown');

  const { event, tenantGroupId, accountId } = delivery;
  try {
    const db = await commerceTenantDbChecked(assertTenantGroupId(tenantGroupId));
    const account = await readAccount(db, event.tenantId);
    if (!account.accountId || account.accountId !== accountId) {
      console.error(`[stripe] event ${event.eventId} for order ${event.orderId} came from another account; ignored`);
      return ignored('account_mismatch');
    }
    const deps = { ...paymentDeps(db, tenantGroupId, event.tenantId, { stripe: api }), connectedAccountId: account.accountId };
    const outcome = await handlePaymentEvent(deps, event);
    if (outcome.status === 'paid' && !outcome.receiptDocumentId) {
      // The payment stands; the receipt is retried on Stripe's next delivery.
      return jsonError('receipt_pending', `the receipt could not be issued yet (${outcome.receiptError})`, 500);
    }
    return Response.json({ received: true, status: outcome.status, duplicate: outcome.duplicate });
  } catch (err) {
    if (err instanceof UnknownPaymentError || isCommerceTenantNotProvisioned(err)) {
      console.error(`[stripe] event ${event.eventId}: no such payment; ignored`, err);
      return ignored('unknown_payment');
    }
    if (err instanceof PaymentMismatchError) {
      console.error(`[stripe] event ${event.eventId}: amount or currency differs from the payment; ignored`);
      return ignored('amount_mismatch');
    }
    console.error(`[stripe] event ${event.eventId} failed:`, err);
    return jsonError('webhook_failed', 'the event could not be applied; deliver it again', 500);
  }
}
