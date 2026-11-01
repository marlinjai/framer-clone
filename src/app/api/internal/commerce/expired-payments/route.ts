// src/app/api/internal/commerce/expired-payments/route.ts
//
// POST /api/internal/commerce/expired-payments
//
// The scheduled close of abandoned checkouts across all companies
// (sweepAllExpiredPayments): every pending payment whose window ran out expires
// and its stock goes back, so a hold ends even in a shop nobody is buying from.
// Called by its own systemd timer on the shared server every 5 minutes
// (deploy/commerce/); with nothing due a call costs one indexed query per tenant
// group. When anything could not be closed the answer is a 500 carrying the
// summary, so the host unit (curl --fail-with-body) fails and the journal and any
// monitor show it; everything else was closed and the next tick tries again.
//
// A host timer for the same reasons as the custom-domain re-check: one
// authenticated caller however many app replicas run, and nothing runs during
// `next build` or in tests. Concurrent calls (a slow pass overlapping the next
// tick, or an order sweeping at the same moment) are harmless: each order's expiry
// is recorded once under its payment's row lock, so its stock goes back once.
//
// Access: src/server/domains/internalAuth.ts (editor host, bearer token), the
// same gate and the same token as the custom-domain endpoints.

import { jsonError } from '@/lib/api/respond';
import { sweepAllExpiredPayments } from '@/server/commerce/payment/expirySweep';
import { checkInternalRequest } from '@/server/domains/internalAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = checkInternalRequest(req);
  if (denied) return denied;

  try {
    const summary = await sweepAllExpiredPayments();
    if (summary.failed > 0) {
      return jsonError('expired_payment_sweep_failed', 'some expired payments could not be closed', 500, { summary });
    }
    return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[payments] the scheduled expiry sweep failed:', err);
    return jsonError('expired_payment_sweep_failed', 'the sweep failed', 500);
  }
}
