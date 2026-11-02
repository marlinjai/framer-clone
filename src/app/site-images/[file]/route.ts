// src/app/site-images/[file]/route.ts
//
// GET /site-images/<sha256>.<ext>, per host: an uploaded image of the site the
// request's host names (its favicon or a sharing image, src/lib/site/
// siteImages.ts). Served on the platform subdomain and on every custom domain
// of a published site, so a path frozen into a revision keeps working whatever
// domain is connected later. No session is read: the host alone decides the
// site, and only that site's images are served.
//
//   - a host that names no published site (the editor, an unknown host, a
//     draft): 404;
//   - an unknown hash, another site's hash, or an extension that does not
//     match the stored type: 404 (existence never leaks);
//   - otherwise the bytes, public and immutable for a year, the hash as ETag
//     (a revalidation answers 304 without the bytes), nosniff and a content
//     security policy that lets nothing load or run.
//
// The hash is unguessable, so an image uploaded but not yet published is
// reachable only by someone who already has its address.

import { parseSiteImageFile } from '@/lib/site/siteImages';
import { getCachedPublishedSite } from '@/server/sites/cachedResolver';
import { matchesEtag, readSiteImage, readSiteImageType, siteImageHeaders } from '@/server/sites/siteImages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ file: string }> };

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const { file } = await params;
  const named = parseSiteImageFile(file);
  if (!named) return notFound();

  let siteId: string | null;
  try {
    siteId = (await getCachedPublishedSite(request.headers.get('host')))?.siteId ?? null;
  } catch (err) {
    console.error('site-images: could not resolve the site.', err);
    return new Response(null, { status: 503 });
  }
  if (!siteId) return notFound();

  if (matchesEtag(request.headers.get('if-none-match'), named.sha256)) {
    const type = await readSiteImageType(siteId, named.sha256);
    if (type !== named.contentType) return notFound();
    return new Response(null, { status: 304, headers: siteImageHeaders(named.sha256, type, 'public') });
  }
  const image = await readSiteImage(siteId, named.sha256);
  if (!image || image.contentType !== named.contentType) return notFound();
  return new Response(Buffer.from(image.bytes), {
    status: 200,
    headers: { ...siteImageHeaders(named.sha256, image.contentType, 'public'), 'content-length': String(image.bytes.byteLength) },
  });
}
