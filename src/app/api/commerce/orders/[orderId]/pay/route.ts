// src/app/api/commerce/orders/[orderId]/pay/route.ts
//
// POST /api/commerce/orders/<orderId>/pay  { buyer?, simulateDecline? }
//
// Pays an order placed on this storefront (docs/plans/2026-10-25-catalogue-design.md, slices 4 and 5).
//   - DEMO provider: moves no money and decides at once; its answer goes through the same handler a real
//     provider's webhook uses (src/server/commerce/payment/payments.ts), so a paid order gets its receipt in
//     the company's Books exactly as with Stripe.
//   - Stripe: a hosted Checkout Session on the company's own Stripe account (a direct charge with the 1%
//     platform fee); the buyer is sent there and the outcome arrives through the webhook.
//
//   200 { status: 'paid', receipt: { documentId, number } | null, receiptError }
//         paid; the receipt, or why it could not be issued yet (the payment stands)
//   200 { status: 'redirect', redirectUrl }   Stripe: send the buyer to its checkout page
//   402 payment_declined     the (simulated) card was declined: the order is closed and its stock released
//   404 not_found            no such order on this storefront (another shop's id answers the same)
//   409 payment_closed       the order is no longer waiting for a payment (paid, failed, expired, ...)
//   409 buyer_fixed          Stripe: a hosted checkout was already started for this order with other buyer details;
//                            its session is made out to them, so this click changes nothing and starts nothing
//                            (checkoutRequest.ts). Pressing Pay again with the same details answers the same page
//   409 order_outdated       the company's tax status changed since a net-priced order was placed, so its total
//                            is wrong: no money moves, the order is closed, its stock released, the buyer checks
//                            out again
//   422 buyer_required       neither the order nor this request carries the buyer's name and address
//   422 buyer_not_invoiceable  this order cannot get a correct invoice for this buyer (invoiceable.ts): no money
//                            moves, the order keeps waiting, and { field } names what the buyer can correct
//   503 payments_unavailable Stripe: the company's Books cannot issue the receipt yet (receiptReadiness.ts): no
//                            money moves, no checkout page opens, the order keeps waiting and pays once they can.
//                            Demo: the company is not the demo company (demoCheckout.ts), so nothing is marked paid
//
// The tenant, the company and the site come from the request host only, as for every storefront route.

import { z } from 'zod';

import { jsonError, parseBody } from '@/lib/api/respond';
import { commerceServerFault } from '@/server/commerce/faults';
import { buyerSchema, readBuyer } from '@/server/commerce/payment/buyer';
import { paymentDeps } from '@/server/commerce/payment/deps';
import {
  handlePaymentEvent,
  sweepExpiredPayments,
  type PaymentOutcome,
} from '@/server/commerce/payment/payments';
import { buyerRefusal } from '@/server/commerce/payment/invoiceable';
import { demoCheckoutAllowed } from '@/server/commerce/payment/demoCheckout';
import { fixCheckoutRequest } from '@/server/commerce/payment/checkoutRequest';
import { PAYMENTS_UNAVAILABLE_MESSAGE, receiptReadiness } from '@/server/commerce/payment/receiptReadiness';
import { demoProvider, type ProviderId } from '@/server/commerce/payment/provider';
import { shopTaxProfile } from '@/server/commerce/payment/shopTax';
import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { toJsonb } from '@/server/books/snapshots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const payBody = z
  .object({
    buyer: buyerSchema.optional(),
    simulateDecline: z.boolean().optional(),
    // Where a hosted checkout returns the buyer: a path on this storefront.
    returnPath: z.string().startsWith('/').max(500).optional(),
  })
  .strict();

const FAILED_MESSAGE = 'the payment could not be completed, please try again later';

export async function POST(req: Request, { params }: { params: Promise<{ orderId: string }> }): Promise<Response> {
  const { orderId } = await params;
  let commerce: Awaited<ReturnType<typeof resolveStorefrontCommerce>>;
  try {
    commerce = await resolveStorefrontCommerce(req.headers.get('host'));
  } catch (err) {
    return commerceServerFault('commerce_payment_failed', FAILED_MESSAGE, 'resolve storefront for payment', err);
  }
  if (!commerce.ok) return commerce.response;
  const { db, tenantGroupId, companyId } = commerce;

  const parsed = await parseBody(req, payBody);
  if (!parsed.ok) return parsed.response;
  const { buyer, simulateDecline, returnPath } = parsed.data;

  try {
    const deps = paymentDeps(db, tenantGroupId, companyId);
    // This order, if its window ran out, closes first (its stock goes back), so it is not paid here. Only this
    // order: every other one has its own expiry job, so no other order's trouble can reach this buyer.
    await sweepExpiredPayments(deps, companyId, { orderId });

    const payment = await db
      .selectFrom('order_payment')
      .innerJoin('order', (join) =>
        join.onRef('order.id', '=', 'order_payment.order_id').onRef('order.tenant_id', '=', 'order_payment.tenant_id'),
      )
      .select([
        'order_payment.status as status',
        'order_payment.provider as provider',
        'order_payment.amount as amount',
        'order_payment.currency_code as currency',
        'order_payment.application_fee_amount as fee',
        'order_payment.buyer as buyer',
        'order_payment.expires_at as expiresAt',
        'order.order_number as orderNumber',
        'order.kleinunternehmer as pricedWithoutVat',
        'order.net_or_gross as netOrGross',
      ])
      .where('order_payment.tenant_id', '=', companyId)
      .where('order_payment.order_id', '=', orderId)
      .executeTakeFirst();
    if (!payment) return jsonError('not_found', 'no such order on this shop', 404);
    if (payment.status !== 'pending') {
      return jsonError('payment_closed', `the order is ${payment.status} and takes no payment`, 409, {
        status: payment.status,
      });
    }
    // Real money only once the Books can issue its receipt. The order route checks this too, but the Books may have
    // changed since the order was placed (a sender block replaced by an incomplete one). First, so the buyer is not
    // asked to correct anything that would not help, and nothing is kept or asked of a provider: the order keeps
    // waiting, and pays once they can.
    // A demo order of any company but the demo company (placed before that rule) is never paid: its receipt would be a
    // real invoice for a sale that never happened (demoCheckout.ts). It keeps waiting until its hold ends.
    if (payment.provider === 'demo' && !demoCheckoutAllowed(companyId)) {
      console.warn(`[payments] order ${orderId}: a demo payment was refused, the company is not the demo company`);
      return jsonError('payments_unavailable', PAYMENTS_UNAVAILABLE_MESSAGE, 503);
    }
    if (payment.provider === 'stripe') {
      const readiness = await receiptReadiness(db, tenantGroupId, companyId);
      if (!readiness.ready) {
        console.warn(`[payments] order ${orderId}: the payment was refused, the Books cannot issue receipts (${readiness.blocker})`);
        return jsonError('payments_unavailable', PAYMENTS_UNAVAILABLE_MESSAGE, 503);
      }
    }
    const tax = await shopTaxProfile(db, companyId);
    // A net price has VAT added on top, so the total depends on the tax status it was placed under; the receipt
    // is issued under today's. A gross total stays the same either way. Without Books there is no status to differ.
    if (payment.netOrGross === 'net' && tax.booksReady && payment.pricedWithoutVat !== tax.kleinunternehmer) {
      await handlePaymentEvent(deps, {
        provider: payment.provider as ProviderId,
        eventId: `order-outdated:${orderId}`,
        type: 'checkout_cancelled',
        tenantId: companyId,
        orderId,
      });
      return jsonError('order_outdated', 'the total of this order is out of date and nothing has been charged', 409);
    }
    const stored = buyer ?? readBuyer(payment.buyer as Record<string, unknown>);
    if (!stored) {
      return jsonError('buyer_required', 'enter the name and address the receipt is made out to', 422);
    }
    // Before anything is kept or any provider is asked: the buyer given with the order is checked as well, and a
    // refused buyer never replaces the one a hosted checkout that is already open will be invoiced to.
    const refusal = buyerRefusal(stored);
    if (refusal) return jsonError('buyer_not_invoiceable', refusal.message, 422, { field: refusal.field });

    if (payment.provider === 'stripe') {
      const host = req.headers.get('host') ?? '';
      const proto = req.headers.get('x-forwarded-proto') ?? 'https';
      // The first click fixes the request and its buyer (checkoutRequest.ts); every later click sends that request, so
      // Stripe answers the same session under the same key, and never a second buyer for an open session.
      const fixed = await fixCheckoutRequest(db, companyId, orderId, stored, {
        buyerEmail: stored.email,
        returnUrl: `${proto}://${host}${returnPath ?? '/'}`,
      });
      if (!fixed.ok && fixed.reason === 'buyer_fixed') {
        return jsonError(
          'buyer_fixed',
          'This order is already waiting for its payment with other details. Pay it with those, or go back to the cart and check out again. Nothing has been charged.',
          409,
        );
      }
      if (!fixed.ok) {
        return jsonError('payment_closed', 'the order no longer takes a payment', 409);
      }
      const started = await deps.provider('stripe').start(
        {
          tenantId: companyId,
          orderId,
          orderNumber: payment.orderNumber,
          amount: payment.amount,
          currency: payment.currency,
          applicationFeeAmount: payment.fee,
          buyerEmail: fixed.request.buyerEmail,
          returnUrl: fixed.request.returnUrl,
          expiresAt: new Date(payment.expiresAt),
        },
        async () => {},
      );
      if (!started.redirectUrl) throw new Error(`Stripe answered no checkout page for order ${orderId}`);
      return Response.json({ status: 'redirect', redirectUrl: started.redirectUrl });
    }

    if (buyer) {
      await db
        .updateTable('order_payment')
        .set({ buyer: toJsonb(buyer), updated_at: new Date() })
        .where('tenant_id', '=', companyId)
        .where('order_id', '=', orderId)
        .where('status', '=', 'pending')
        .execute();
    }

    let outcome: PaymentOutcome | undefined;
    await demoProvider.start(
      {
        tenantId: companyId,
        orderId,
        orderNumber: payment.orderNumber,
        amount: payment.amount,
        currency: payment.currency,
        applicationFeeAmount: payment.fee,
        buyerEmail: stored.email,
        simulateDecline,
      },
      async (event) => {
        outcome = await handlePaymentEvent(deps, event);
      },
    );
    if (!outcome) throw new Error(`the demo provider reported nothing for order ${orderId}`);

    if (outcome.status === 'failed') {
      return jsonError('payment_declined', 'the card was declined (a simulated decline, no money moved)', 402, {
        status: outcome.status,
      });
    }
    let receipt: { documentId: string; number: string | null } | null = null;
    if (outcome.receiptDocumentId) {
      const doc = await db
        .selectFrom('sales_document')
        .select('document_number')
        .where('tenant_id', '=', companyId)
        .where('id', '=', outcome.receiptDocumentId)
        .executeTakeFirst();
      receipt = { documentId: outcome.receiptDocumentId, number: doc?.document_number ?? null };
    }
    return Response.json({ status: outcome.status, receipt, receiptError: outcome.receiptError });
  } catch (err) {
    return commerceServerFault('commerce_payment_failed', FAILED_MESSAGE, 'pay order', err);
  }
}
