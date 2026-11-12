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
import { isPreviewHost } from '@/lib/sites/previewHost';
import { resolvePreviewLink } from '@/server/sites/branches/previewLinks';
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

/**
 * This route is outside the middleware's matcher, so a preview host gets here what the middleware sets on its
 * pages: never stored, never indexed, never sent on as a referrer.
 */
function asPreview(response: Response, image = false): Response {
  // An image itself may stay in the visitor's own browser, but is asked for again every time (`no-cache`): the
  // answer is then a 304 without the bytes, given only after the link was resolved for that request, so a
  // revoked or expired link still ends every picture at once. Everything else is never stored.
  response.headers.set('cache-control', image ? 'private, no-cache' : 'private, no-store');
  response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const { file } = await params;
  const named = parseSiteImageFile(file);
  if (!named) return isPreviewHost(request.headers.get('host')) ? asPreview(notFound()) : notFound();

  // A branch's public preview shows its site's images (they belong to main), but privately: the address is a
  // secret that ends, so nothing of it may sit in a shared cache or be loaded by another origin.
  const host = request.headers.get('host');
  const preview = isPreviewHost(host);
  const visibility = preview ? 'private' : 'public';
  let siteId: string | null;
  try {
    siteId = (preview ? await resolvePreviewLink(host) : await getCachedPublishedSite(host))?.siteId ?? null;
  } catch (err) {
    console.error('site-images: could not resolve the site.', err);
    return preview ? asPreview(new Response(null, { status: 503 })) : new Response(null, { status: 503 });
  }
  if (!siteId) return preview ? asPreview(notFound()) : notFound();
  const headersFor = (sha: string, type: string) => siteImageHeaders(sha, type, visibility);
  const answer = (response: Response) => (preview ? asPreview(response, response.status === 200 || response.status === 304) : response);

  if (matchesEtag(request.headers.get('if-none-match'), named.sha256)) {
    const type = await readSiteImageType(siteId, named.sha256);
    if (type !== named.contentType) return answer(notFound());
    return answer(new Response(null, { status: 304, headers: headersFor(named.sha256, type) }));
  }
  const image = await readSiteImage(siteId, named.sha256);
  if (!image || image.contentType !== named.contentType) return answer(notFound());
  return answer(
    new Response(Buffer.from(image.bytes), {
      status: 200,
      headers: { ...headersFor(named.sha256, image.contentType), 'content-length': String(image.bytes.byteLength) },
    }),
  );
}
