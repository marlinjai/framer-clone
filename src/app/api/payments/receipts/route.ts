// src/app/api/payments/receipts/route.ts
//
// GET /api/payments/receipts -> { count, orders: [{ orderId, orderNumber, paidAt, reason, state }] }
//
// The company's paid orders without an invoice, for the payments page (src/server/commerce/payment/unissuedReceipts.ts):
// money taken with no receipt is never silent. `reason` is the stable code the last attempt failed with, `state` says
// whether the receipt's job still retries or has stopped for a person. Guarded by companyOwnerRoute (editor host,
// session, active company, editSite), so it answers for a shop without Stripe too.

import { companyOwnerRoute } from '@/server/commerce/companyOwnerRoute';
import { unissuedReceipts } from '@/server/commerce/payment/unissuedReceipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = companyOwnerRoute(async (ctx) => {
  const { count, orders } = await unissuedReceipts(ctx.db, ctx.companyId);
  return Response.json(
    { count, orders: orders.map((order) => ({ ...order, paidAt: order.paidAt.toISOString() })) },
    { headers: { 'cache-control': 'no-store' } },
  );
});
