// src/app/api/payments/stripe/return/route.ts
//
// GET /api/payments/stripe/return: back from Stripe's hosted onboarding; the account's readiness is asked of
// Stripe and stored. Guarded by ownerRoute; behaviour in src/server/commerce/payment/stripe/ownerHandlers.ts.

import { onboardingReturn } from '@/server/commerce/payment/stripe/ownerHandlers';
import { ownerRoute } from '@/server/commerce/payment/stripe/ownerRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = ownerRoute((ctx, req) => onboardingReturn(ctx, req));
