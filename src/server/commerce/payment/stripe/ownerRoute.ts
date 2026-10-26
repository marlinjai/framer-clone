import 'server-only';

// src/server/commerce/payment/stripe/ownerRoute.ts
//
// The guard of the routes a company owner uses to connect a Stripe account (slice 5). In order, first failure
// wins: editor host only (404 elsewhere), a verified session (401), the editor's active company with the
// `sites` grant (403, resolveActiveScope), `editSite` on its workspace (403: connecting payments is an
// admin's act), its provisioned tenant schema (404 commerce_not_provisioned), Stripe configured (503
// stripe_not_configured). Nothing comes from the client but the request itself.

import type { Kysely } from 'kysely';
import { assertTenantGroupId } from '@marlinjai/tenant-db';

import { jsonError } from '@/lib/api/respond';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { authenticateRequest, getVerifiedSession } from '@/lib/auth-api';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { isEditorHost } from '@/lib/editorHost';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites/scope';
import type { CommerceDB } from '../../db-types';
import { httpStripeApi, stripeConfig, type StripeApi, type StripeConfig } from './client';

export interface OwnerContext {
  db: Kysely<CommerceDB>;
  companyId: string;
  tenantGroupId: string;
  email: string | null;
  api: StripeApi;
  config: StripeConfig;
}

export function ownerRoute(handler: (ctx: OwnerContext, req: Request) => Promise<Response>) {
  return withAuthAvailability(async (req: Request): Promise<Response> => {
    if (!isEditorHost(req.headers.get('host'))) return jsonError('not_found', 'not found', 404);
    const session = await getVerifiedSession(req);
    if (!session) return jsonError('unauthorized', 'authentication required', 401);
    const scope = resolveActiveScope(session, readCompanySelectors(req));
    if (!scope.ok) {
      const denial = activeScopeDenial(scope.error);
      return jsonError(denial.code, denial.message, 403);
    }
    const auth = await authenticateRequest(req, scope.scope.workspaceId, 'editSite');
    if (!auth.authenticated) {
      return jsonError(auth.status === 401 ? 'unauthorized' : 'forbidden', auth.error, auth.status);
    }
    let db: Kysely<CommerceDB>;
    try {
      db = await commerceTenantDbChecked(assertTenantGroupId(scope.scope.tenantGroupId));
    } catch (err) {
      if (isCommerceTenantNotProvisioned(err)) {
        return jsonError('commerce_not_provisioned', 'this company has no shop yet: create a site first', 404);
      }
      throw err;
    }
    const config = stripeConfig();
    if (!config) {
      return jsonError('stripe_not_configured', 'payments through Stripe are not set up on this platform yet', 503);
    }
    const email = (session.user as { email?: string | null }).email ?? null;
    return handler(
      { db, companyId: scope.companyId, tenantGroupId: scope.scope.tenantGroupId, email, api: httpStripeApi(config), config },
      req,
    );
  });
}
