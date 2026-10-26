// src/app/api/payments/stripe/oauth/callback/route.ts
//
// GET /api/payments/stripe/oauth/callback: Stripe's OAuth return; the state must name the active company.
// Guarded by ownerRoute; behaviour in src/server/commerce/payment/stripe/ownerHandlers.ts.

import { oauthCallback } from '@/server/commerce/payment/stripe/ownerHandlers';
import { ownerRoute } from '@/server/commerce/payment/stripe/ownerRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = ownerRoute((ctx, req) => oauthCallback(ctx, req));
