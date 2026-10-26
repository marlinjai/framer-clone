// src/app/api/commerce/orders/[orderId]/pay/route.ts
//
// POST /api/commerce/orders/<orderId>/pay  { buyer?, simulateDecline? }
//
// Pays an order placed on this storefront with the DEMO provider, which moves no money and decides at once
// (docs/plans/2026-10-25-catalogue-design.md, slice 4). Its answer goes through the same handler a real
// provider's webhook uses (src/server/commerce/payment/payments.ts), so a paid order gets its receipt in the
// company's Books exactly as it will with Stripe.
//
//   200 { status: 'paid', receipt: { documentId, number } | null, receiptError }
//         paid; the receipt, or why it could not be issued yet (the payment stands)
//   402 payment_declined     the (simulated) card was declined: the order is closed and its stock released
//   404 not_found            no such order on this storefront (another shop's id answers the same)
//   409 payment_closed       the order is no longer waiting for a payment (paid, failed, expired, ...)
//   409 hosted_checkout      the order is paid through a hosted checkout, not here
//   422 buyer_required       neither the order nor this request carries the buyer's name and address
//
// The tenant, the company and the site come from the request host only, as for every storefront route.

import { z } from 'zod';

import { jsonError, parseBody } from '@/lib/api/respond';
import { commerceServerFault } from '@/server/commerce/faults';
import { buyerSchema, readBuyer } from '@/server/commerce/payment/buyer';
import { paymentDeps } from '@/server/commerce/payment/deps';
import { handlePaymentEvent, sweepExpiredPayments, type PaymentOutcome } from '@/server/commerce/payment/payments';
import { demoProvider } from '@/server/commerce/payment/provider';
import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { toJsonb } from '@/server/books/snapshots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const payBody = z
  .object({
    buyer: buyerSchema.optional(),
    simulateDecline: z.boolean().optional(),
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
  const { buyer, simulateDecline } = parsed.data;

  try {
    const deps = paymentDeps(db, tenantGroupId, companyId);
    // A payment whose window ran out closes first (its stock goes back), so it is not paid here.
    await sweepExpiredPayments(deps, companyId);

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
        'order.order_number as orderNumber',
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
    if (payment.provider !== 'demo') {
      return jsonError('hosted_checkout', 'this order is paid through the hosted checkout', 409);
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
    const stored = buyer ?? readBuyer(payment.buyer as Record<string, unknown>);
    if (!stored) {
      return jsonError('buyer_required', 'enter the name and address the receipt is made out to', 422);
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
