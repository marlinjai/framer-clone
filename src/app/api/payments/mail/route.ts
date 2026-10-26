// src/app/api/payments/mail/route.ts
//
// The shop's receipt email on the payments page (docs/plans/2026-10-27-shop-receipt-email.md): GET the
// connection and the person's workspaces of the company, POST to connect one, DELETE to disconnect. Guarded by
// companyOwnerRoute (editor host, session, active company, editSite); behaviour in
// src/server/commerce/mail/ownerHandlers.ts.

import { companyOwnerRoute } from '@/server/commerce/companyOwnerRoute';
import { mailConnect, mailDisconnect, mailStatus, platformMailOwnerDeps } from '@/server/commerce/mail/ownerHandlers';
import { platformLumitraMail } from '@/server/commerce/mail/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = companyOwnerRoute((ctx) => mailStatus(ctx, platformMailOwnerDeps(platformLumitraMail())));
export const POST = companyOwnerRoute((ctx, req) => mailConnect(ctx, platformMailOwnerDeps(platformLumitraMail()), req));
export const DELETE = companyOwnerRoute((ctx) => mailDisconnect(ctx, platformMailOwnerDeps(platformLumitraMail())));
