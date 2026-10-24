// GET /robots.txt, per host (plan docs/plans/2026-10-23-published-site-essentials.md,
// decision 2). A published site's host (platform subdomain or verified custom
// domain, resolved like the page routes): allow everything, point at the
// sitemap on the primary host (src/lib/site/siteFiles.ts, buildRobotsTxt, which
// explains why noindex pages are not disallowed). A host that names no
// published site (the editor among them): disallow everything, so an
// auth-gated surface or an unknown host is never crawled. The middleware's
// matcher leaves this path open, so it is served anonymously.

import { resolveSiteAndPrimaryHost } from '@/server/sites/requestSite';
import { buildRobotsTxt } from '@/lib/site/siteFiles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };

export async function GET(request: Request): Promise<Response> {
  try {
    const resolved = await resolveSiteAndPrimaryHost(request.headers.get('host'));
    if (!resolved) {
      return new Response('User-agent: *\nDisallow: /\n', { headers: TEXT });
    }
    return new Response(buildRobotsTxt(resolved.primaryHost), {
      headers: { ...TEXT, 'cache-control': 'public, max-age=300' },
    });
  } catch (err) {
    console.error('robots.txt: could not resolve the site.', err);
    // A 503 tells crawlers to come back, instead of a robots.txt that is wrong.
    return new Response('Service unavailable\n', { status: 503, headers: TEXT });
  }
}
