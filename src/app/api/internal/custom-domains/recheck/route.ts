// src/app/api/internal/custom-domains/recheck/route.ts
//
// POST /api/internal/custom-domains/recheck
//
// The scheduled re-check of live custom domains (DomainService.recheckDue):
// each call checks at most 20 verified or active domains whose last check is
// older than six hours, routing only, and releases a domain after three
// definitive failures in a row (transient DNS errors never count). Called by
// the same systemd timer on the shared server that runs the Traefik sync,
// once a minute; with nothing due a call costs one indexed query.
//
// Why the host timer and not an interval inside the app: the timer is already
// a single, authenticated caller, so there is exactly one scheduler however
// many app replicas run, with no leader election, and nothing runs during
// `next build` or in tests. Concurrent calls (a slow pass overlapping the next
// tick) are harmless: every write is a per-row update and a double check only
// moves the same counter by one more.
//
// Access: src/server/domains/internalAuth.ts (editor host, bearer token).

import { jsonError } from '@/lib/api/respond';
import { readCustomDomainConfig } from '@/server/domains/config';
import { CUSTOM_DOMAINS_NOT_CONFIGURED } from '@/server/domains/http';
import { checkInternalRequest } from '@/server/domains/internalAuth';
import { getDomainService } from '@/server/domains/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const denied = checkInternalRequest(req);
  if (denied) return denied;

  const config = readCustomDomainConfig();
  if (!config.configured) {
    return jsonError(CUSTOM_DOMAINS_NOT_CONFIGURED, 'custom domains are not configured', 503);
  }
  try {
    const summary = await getDomainService().recheckDue(config.config);
    if (summary.released > 0 || summary.failing > 0) {
      console.error(`[domains] scheduled re-check: ${JSON.stringify(summary)}`);
    }
    return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[domains] scheduled re-check failed:', err);
    return jsonError('domain_request_failed', 'the re-check failed', 500);
  }
}
