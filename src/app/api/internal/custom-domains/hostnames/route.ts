// src/app/api/internal/custom-domains/hostnames/route.ts
//
// GET /api/internal/custom-domains/hostnames
//
// The feed the host-side Traefik sync (deploy/custom-domains/sync-traefik.sh,
// run every minute by a systemd timer on the shared server) polls to learn
// which custom hostnames the proxy must route and request certificates for.
//
// THE SECURITY BOUNDARY: this endpoint returns DATA (hostnames, one per line,
// plain text), never proxy configuration. The script on the host owns the
// Traefik template, re-validates every line against its own copy of the
// hostname rule, checks the body against the count and SHA-256 headers below,
// and refuses suspicious drops, so even a compromised app could at most add
// `Host(...)` routes to its own service for names whose DNS already points at
// the platform. The list comes only from verified or active rows
// (DomainService.listProxyHostnames): active first, then oldest verification,
// capped at 1000 (`x-hostname-truncated: true` when the cap cut it).
//
// Access: src/server/domains/internalAuth.ts (editor host, bearer token).

import { createHash } from 'node:crypto';
import { jsonError } from '@/lib/api/respond';
import { checkInternalRequest } from '@/server/domains/internalAuth';
import { getDomainService } from '@/server/domains/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const denied = checkInternalRequest(req);
  if (denied) return denied;

  let list: Awaited<ReturnType<ReturnType<typeof getDomainService>['listProxyHostnames']>>;
  try {
    list = await getDomainService().listProxyHostnames();
  } catch (err) {
    // A 5xx makes the sync keep the current proxy file (fail closed).
    console.error('[domains] listing proxy hostnames failed:', err);
    return jsonError('domain_request_failed', 'could not list the hostnames', 500);
  }
  const body = list.hostnames.length > 0 ? `${list.hostnames.join('\n')}\n` : '';
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-hostname-count': String(list.hostnames.length),
      'x-hostname-truncated': list.truncated ? 'true' : 'false',
      'x-content-sha256': createHash('sha256').update(body).digest('hex'),
    },
  });
}
