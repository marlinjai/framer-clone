// src/app/api/projects/[projectId]/images/route.ts
//
// POST /api/projects/<projectId>/images?kind=favicon|sharing   body: the file's bytes
//   -> 201 { sha256, contentType, byteSize, width, height, path, warnings }   stored now
//   -> 200 { ... }                                                           the site stored these bytes before
//
// The upload of a site's favicon or sharing image (Site settings, and a page's
// own sharing image in Page settings). The body is the file itself, read as a
// bounded stream (at most 2 MB, also without a Content-Length); the type comes
// from the bytes, never from the Content-Type or a file name
// (src/lib/site/siteImages.ts: PNG or ICO for a favicon, PNG, JPEG or WebP for
// a sharing image, never SVG). `path` is what the settings store; it is served
// on every host of the site (src/app/site-images/[file]/route.ts). `warnings`
// say what works but will look poor (a non-square icon, a sharing image far
// from 1200 by 630).
//
// Guarded like every per-project editor route (src/server/domains/guard.ts):
// editor host only (404 elsewhere), a verified session (401), the project's
// workspace in a company with the `sites` grant plus `editSite` (403, also for
// an unknown project), auth-brain or OpenFGA outages as 503. Errors use the
// `{ error: { code, message } }` envelope, each message saying what to do:
//   400 bad_kind                 `kind` is not favicon or sharing
//   409 image_limit              the site stores 100 images or 50 MB (the message
//                                names the way forward: delete unused images)
//   413 image_too_large          more than 2 MB
//   415 unsupported_image_type   not an accepted type for this kind (SVG named as such)
//   422 image_invalid            unreadable header, too many pixels, a favicon under 16 or over 1024 px
//   429 rate_limited             more than 30 upload attempts by the user in 10 minutes (Retry-After)
//   500 image_upload_failed      anything else; nothing was stored
// The log line carries the site, the hash and the size only.
//
// GET /api/projects/<projectId>/images   (viewSite)
//   -> 200 { items: [{ sha256, contentType, byteSize, width, height, path, inUse, createdAt }],
//            totalBytes, maxImages, maxBytes }
// The site's uploaded images, newest first, for the "Uploaded images" list in
// Site settings: `inUse` is what the delete checks (the settings, a page or a
// kept published version names it), so the list offers a delete only for an
// image nothing names.

import { jsonError } from '@/lib/api/respond';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { MAX_SITE_IMAGE_BYTES, isSiteImageKind, siteImageWarnings, tooLargeProblem } from '@/lib/site/siteImages';
import { boundedBytes } from '@/server/books/http/boundedBody';
import { authorizeDomainProject } from '@/server/domains/guard';
import { SiteImageError, listSiteImages, storeSiteImage } from '@/server/sites/siteImages';
import { getUploadRateLimiter, uploadRateLimitedResponse } from '@/server/uploads/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'editSite');
  if (!auth.ok) return auth.response;

  const kind = new URL(req.url).searchParams.get('kind');
  if (!isSiteImageKind(kind)) {
    return jsonError('bad_kind', 'Say which image this is: kind=favicon, kind=sharing or kind=scene.', 400);
  }
  // Counted before the body is read: every attempt, accepted or not.
  const limited = getUploadRateLimiter().hit('site-images', auth.userId, Date.now());
  if (!limited.ok) return uploadRateLimitedResponse(limited.retryAfterSec);
  const bytes = await boundedBytes(req, MAX_SITE_IMAGE_BYTES);
  if (bytes === null) {
    const problem = tooLargeProblem();
    return jsonError(problem.code, problem.message, problem.status);
  }
  try {
    const { image, created } = await storeSiteImage(auth.project, bytes, kind, auth.userId);
    console.info(`[site-images] site ${auth.project.id}: ${image.sha256} ${created ? 'stored' : 'already stored'} (${image.byteSize} bytes)`);
    return Response.json(
      { ...image, warnings: siteImageWarnings(kind, image) },
      { status: created ? 201 : 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof SiteImageError) return jsonError(err.code, err.message, err.status);
    console.error(`[site-images] site ${auth.project.id}: upload failed`, err);
    return jsonError('image_upload_failed', 'The image could not be stored. Nothing was saved; try again in a moment.', 500);
  }
}

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'viewSite');
  if (!auth.ok) return auth.response;
  try {
    return Response.json(await listSiteImages(auth.project.id), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error(`[site-images] site ${auth.project.id}: listing failed`, err);
    return jsonError('image_list_failed', 'The uploaded images could not be listed. Try again in a moment.', 500);
  }
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`.
export const POST = withAuthAvailability(handlePOST);
export const GET = withAuthAvailability(handleGET);
