// GET /favicon.ico, per host. Browsers ask for /favicon.ico on their own, even
// when a page links its icon, so it must answer for the right site:
//   - a published site with a favicon (Site settings): a redirect to it (an
//     uploaded one is a path on this same host, src/app/site-images/[file]);
//   - a published site without one: 404 (never the platform's icon);
//   - any other host (the editor): a redirect to the platform icon.
// This replaces the app-directory `favicon.ico` file, which Next linked on
// every route, published sites included.

import { resolveSiteAndPrimaryHost } from '@/server/sites/requestSite';
import { iconHref } from '@/lib/site/publishedHead';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The platform icon, a static file in public/. */
const PLATFORM_FAVICON_PATH = '/platform-favicon.ico';

export async function GET(request: Request): Promise<Response> {
  let resolved: Awaited<ReturnType<typeof resolveSiteAndPrimaryHost>> = null;
  try {
    resolved = await resolveSiteAndPrimaryHost(request.headers.get('host'));
  } catch (err) {
    console.error('favicon.ico: could not resolve the site.', err);
    return new Response(null, { status: 503 });
  }
  if (!resolved) {
    return new Response(null, {
      status: 307,
      headers: { location: PLATFORM_FAVICON_PATH, 'cache-control': 'public, max-age=3600' },
    });
  }
  const icon = iconHref(resolved.site.siteSettings.faviconUrl);
  if (!icon) {
    return new Response(null, { status: 404, headers: { 'cache-control': 'public, max-age=300' } });
  }
  return new Response(null, {
    status: 307,
    headers: { location: icon, 'cache-control': 'public, max-age=300' },
  });
}
