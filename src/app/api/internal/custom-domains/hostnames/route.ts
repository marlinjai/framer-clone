// src/app/api/internal/custom-domains/hostnames/route.ts
//
// GET /api/internal/custom-domains/hostnames
//
// The feed the host-side Traefik sync (deploy/custom-domains/sync-traefik.sh,
// run every minute by a systemd timer on the shared server) polls to learn
// which custom hostnames the proxy must route and request certificates for.
//
// THE SECURITY BOUNDARY: this endpoint returns DATA (a sorted list of
// hostnames, one per line, plain text), never proxy configuration. The script
// on the host owns the Traefik template, re-validates every line against its
// own copy of the hostname rule and caps the count, so even a compromised app
// could at most add `Host(...)` routes to its own service for names whose DNS
// already points at the platform (Let's Encrypt's HTTP-01 must still succeed).
// The list comes only from verified or active rows (DomainService
// .listProxyHostnames, re-checked against the hostname contract).
//
// Access: editor host only (404 elsewhere), and a bearer token equal to
// CUSTOM_DOMAIN_SYNC_TOKEN, compared in constant time (401 otherwise). No
// token configured means 503 custom_domains_not_configured, never an open
// endpoint. Outside the middleware matcher on purpose: it carries no session.

import { createHash, timingSafeEqual } from 'node:crypto';
import { jsonError } from '@/lib/api/respond';
import { isEditorHost } from '@/lib/editorHost';
import { CUSTOM_DOMAINS_NOT_CONFIGURED } from '@/server/domains/http';
import { getDomainService } from '@/server/domains/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The shortest sync token accepted (a generated 32-byte value is far longer). */
const MIN_SYNC_TOKEN_LENGTH = 32;

function tokenMatches(presented: string, expected: string): boolean {
  // Hash both sides so the comparison is constant time and length-blind.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request): Promise<Response> {
  if (!isEditorHost(req.headers.get('host'))) {
    return jsonError('not_found', 'not found', 404);
  }
  const expected = process.env.CUSTOM_DOMAIN_SYNC_TOKEN?.trim() ?? '';
  if (expected.length < MIN_SYNC_TOKEN_LENGTH) {
    console.error('[domains] CUSTOM_DOMAIN_SYNC_TOKEN is not set (or too short); the proxy feed is off');
    return jsonError(CUSTOM_DOMAINS_NOT_CONFIGURED, 'the custom-domain feed is not configured', 503);
  }
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!presented || !tokenMatches(presented, expected)) {
    return jsonError('unauthorized', 'authentication required', 401);
  }

  let hostnames: string[];
  try {
    hostnames = await getDomainService().listProxyHostnames();
  } catch (err) {
    // A 5xx makes the sync keep the current proxy file (fail closed).
    console.error('[domains] listing proxy hostnames failed:', err);
    return jsonError('domain_request_failed', 'could not list the hostnames', 500);
  }
  const body = hostnames.length > 0 ? `${hostnames.join('\n')}\n` : '';
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-hostname-count': String(hostnames.length),
      'x-content-sha256': createHash('sha256').update(body).digest('hex'),
    },
  });
}
