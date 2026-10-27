// src/app/api/payments/mail/senders/route.ts
//
// GET /api/payments/mail/senders?workspace=<id>: the sending accounts of one of the company's Lumitra Mail
// workspaces, to choose from when connecting the receipt email. Guarded by companyOwnerRoute; behaviour in
// src/server/commerce/mail/ownerHandlers.ts.

import { companyOwnerRoute } from '@/server/commerce/companyOwnerRoute';
import { mailSenders, platformMailOwnerDeps } from '@/server/commerce/mail/ownerHandlers';
import { platformLumitraMail } from '@/server/commerce/mail/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = companyOwnerRoute((ctx, req) => mailSenders(ctx, platformMailOwnerDeps(platformLumitraMail()), req));
