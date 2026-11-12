// src/server/models/serveModel.ts
//
// GET /site-models/<sha256>.glb, as a function of its ports (the route file that wires the real
// host resolver and the Storage Brain adapter is GATED and not written here). Counterpart of
// src/app/site-images/[file]/route.ts: the host alone decides the site, only that site's models
// are served, and existence never leaks (an unknown hash and another site's hash are both 404).

import { matchesModelEtag, parseSiteModelFile, siteModelHeaders, type ModelVisibility } from '@/lib/scene/modelFile';
import type { ModelBlobStore, SiteModelRepository } from './ports';

export interface ServeDeps {
  /** The site a host names and whether it is a preview host, or null. May throw. */
  resolveSite(host: string | null): Promise<{ siteId: string; preview: boolean } | null>;
  models: SiteModelRepository;
  blobs: ModelBlobStore;
}

const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } });

function asPreview(response: Response, model: boolean): Response {
  response.headers.set('cache-control', model ? 'private, no-cache' : 'private, no-store');
  response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

export async function serveSiteModel(request: Request, file: string, deps: ServeDeps): Promise<Response> {
  const host = request.headers.get('host');
  const named = parseSiteModelFile(file);
  let site: { siteId: string; preview: boolean } | null;
  try { site = await deps.resolveSite(host); } catch { return new Response(null, { status: 503 }); }
  const wrap = (r: Response, model = false) => (site?.preview ? asPreview(r, model) : r);
  if (!named || !site) return wrap(notFound());

  const visibility: ModelVisibility = site.preview ? 'private' : 'public';
  const record = await deps.models.find(site.siteId, named.sha256);
  if (!record) return wrap(notFound());
  if (matchesModelEtag(request.headers.get('if-none-match'), named.sha256)) {
    return wrap(new Response(null, { status: 304, headers: siteModelHeaders(named.sha256, visibility) }), true);
  }
  const bytes = await deps.blobs.get(`served/${named.sha256}`);
  if (!bytes) return wrap(new Response(null, { status: 502 }));
  return wrap(new Response(Buffer.from(bytes), { status: 200, headers: { ...siteModelHeaders(named.sha256, visibility), 'content-length': String(bytes.byteLength) } }), true);
}
