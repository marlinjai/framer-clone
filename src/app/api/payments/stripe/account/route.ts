// src/app/api/payments/stripe/account/route.ts
//
// GET /api/payments/stripe/account: the active company's Stripe account status (not_connected, pending,
// ready, restricted). Guarded by ownerRoute (editor host, session, active company, editSite); behaviour in
// src/server/commerce/payment/stripe/ownerHandlers.ts.

import { accountStatus } from '@/server/commerce/payment/stripe/ownerHandlers';
import { ownerRoute } from '@/server/commerce/payment/stripe/ownerRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = ownerRoute((ctx) => accountStatus(ctx));
