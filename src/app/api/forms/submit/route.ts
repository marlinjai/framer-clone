// src/app/api/forms/submit/route.ts
//
// POST /api/forms/submit: a visitor sends a form on a published site. The whole
// flow (host gate, spam protection, validation against the published form,
// storage) lives in src/server/forms/submit.ts; this module wires the real
// dependencies. Open on every host (not in the middleware matcher): an editor
// host resolves to no published site and answers 403.

import { resolveStorefrontCommerce } from '@/server/commerce/storefrontTenant';
import { handleFormSubmit, newSubmissionId } from '@/server/forms/submit';
import { insertFormSubmission } from '@/server/forms/repository';
import { getFormRateLimiter } from '@/server/forms/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleFormSubmit(req, {
    resolveSite: resolveStorefrontCommerce,
    store: insertFormSubmission,
    limiter: getFormRateLimiter(),
    now: () => Date.now(),
    newId: newSubmissionId,
    log: (level, message, err) => {
      if (err !== undefined) console[level](message, err);
      else console[level](message);
    },
  });
}
