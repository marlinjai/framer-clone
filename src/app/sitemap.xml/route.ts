// GET /sitemap.xml, per host (plan decision 2): every published page of the
// host's site on its primary host, with lastmod, minus noindex pages and the
// 404 page; dynamic pages expanded from their collection or catalog when that
// is possible within a bound (src/lib/site/siteFiles.ts). A host that names no
// published site answers 404.

import { resolveSiteAndPrimaryHost } from '@/server/sites/requestSite';
import { loadSitemapExpansions } from '@/server/sites/sitemap';
import { buildSitemapXml, sitemapEntries } from '@/lib/site/siteFiles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const resolved = await resolveSiteAndPrimaryHost(request.headers.get('host'));
    if (!resolved) {
      return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const { site, primaryHost } = resolved;
    const expansions = await loadSitemapExpansions(site);
    const xml = buildSitemapXml(sitemapEntries(site.pages, site.siteSettings, primaryHost, expansions));
    return new Response(xml, {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  } catch (err) {
    console.error('sitemap.xml: could not build the sitemap.', err);
    return new Response('Service unavailable\n', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
