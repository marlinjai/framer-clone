// src/app/api/payments/stripe/onboarding/route.ts
//
// POST /api/payments/stripe/onboarding: Stripe's hosted onboarding link for the active company (a new
// Standard account created first when it has none). Guarded by ownerRoute; behaviour in
// src/server/commerce/payment/stripe/ownerHandlers.ts.

import { onboarding } from '@/server/commerce/payment/stripe/ownerHandlers';
import { ownerRoute } from '@/server/commerce/payment/stripe/ownerRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = ownerRoute((ctx, req) => onboarding(ctx, req));
