// src/app/api/payments/stripe/oauth/start/route.ts
//
// GET /api/payments/stripe/oauth/start: connect an existing Stripe account through Stripe's OAuth, the state
// signed and bound to the active company. Guarded by ownerRoute; behaviour in
// src/server/commerce/payment/stripe/ownerHandlers.ts.

import { oauthStart } from '@/server/commerce/payment/stripe/ownerHandlers';
import { ownerRoute } from '@/server/commerce/payment/stripe/ownerRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = ownerRoute((ctx, req) => oauthStart(ctx, req));
