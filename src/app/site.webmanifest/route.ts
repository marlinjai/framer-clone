// GET /site.webmanifest, per host (plan decision 1): the web manifest every
// published page links (siteLayoutMetadata), with the site's name, language
// and favicon. A host that names no published site answers 404.

import { resolveSiteAndPrimaryHost } from '@/server/sites/requestSite';
import { buildWebManifest } from '@/lib/site/siteFiles';
import { effectiveSiteName } from '@/lib/site/siteSettings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const resolved = await resolveSiteAndPrimaryHost(request.headers.get('host'));
    if (!resolved) {
      return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
    }
    const { site } = resolved;
    return new Response(
      JSON.stringify(buildWebManifest(site.siteSettings, effectiveSiteName(site.siteSettings, site.name))),
      { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=300' } },
    );
  } catch (err) {
    console.error('site.webmanifest: could not resolve the site.', err);
    return Response.json({ error: { code: 'unavailable', message: 'service unavailable' } }, { status: 503 });
  }
}
