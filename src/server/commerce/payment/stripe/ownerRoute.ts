import 'server-only';

// src/server/commerce/payment/stripe/ownerRoute.ts
//
// The guard of the routes a company owner uses to connect a Stripe account (slice 5): the company owner guard
// (src/server/commerce/companyOwnerRoute.ts: editor host, session, active company, editSite, provisioned
// schema), then Stripe configured (503 stripe_not_configured).

import { jsonError } from '@/lib/api/respond';
import { companyOwnerRoute, type CompanyOwnerContext } from '../../companyOwnerRoute';
import { httpStripeApi, stripeConfig, type StripeApi, type StripeConfig } from './client';

export interface OwnerContext extends CompanyOwnerContext {
  api: StripeApi;
  config: StripeConfig;
}

export function ownerRoute(handler: (ctx: OwnerContext, req: Request) => Promise<Response>) {
  return companyOwnerRoute(async (ctx, req) => {
    const config = stripeConfig();
    if (!config) {
      return jsonError('stripe_not_configured', 'payments through Stripe are not set up on this platform yet', 503);
    }
    return handler({ ...ctx, api: httpStripeApi(config), config }, req);
  });
}
