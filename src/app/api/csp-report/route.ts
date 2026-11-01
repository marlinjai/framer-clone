// src/app/api/csp-report/route.ts
//
// POST /api/csp-report: where browsers send what the report-only policy of a
// published page would have blocked. The flow (limits, host gate, what is kept)
// lives in src/server/sites/cspReports.ts; this module wires the real
// dependencies. Open: a browser posts it with no session, the middleware's
// cross-origin refusal only runs on the editor host, and an editor host resolves
// to no published site and answers 404.

import { getPrismaClient } from '@/server/db';
import { getCachedPublishedSite } from '@/server/sites/cachedResolver';
import { getCspReportDrops, getCspReportLimiter, handleCspReport } from '@/server/sites/cspReports';
import { recordCspViolation } from '@/server/sites/cspReportStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleCspReport(req, {
    resolveSiteId: async (host) => (await getCachedPublishedSite(host))?.siteId ?? null,
    store: (siteId, violation) => recordCspViolation(getPrismaClient(), siteId, violation, new Date()),
    limiter: getCspReportLimiter(),
    drops: getCspReportDrops(),
    now: () => Date.now(),
  });
}
