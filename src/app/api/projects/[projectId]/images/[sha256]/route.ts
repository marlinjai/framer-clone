// src/app/api/projects/[projectId]/images/[sha256]/route.ts
//
// GET /api/projects/<projectId>/images/<sha256>  -> the image bytes
//
// An uploaded image of the project's site, for the editor: the previews in Site
// settings and Page settings. Visitors read the same bytes on the site's own
// hosts (src/app/site-images/[file]/route.ts). Guarded like every per-project
// editor route (src/server/domains/guard.ts) with `viewSite`; an unknown,
// malformed or another site's hash answers 404 `image_not_found`, never
// revealing whether it exists elsewhere. The bytes behind a hash never change
// and are never deleted while the site exists, so the browser keeps them
// privately for a year and the hash is the ETag.

import { jsonError } from '@/lib/api/respond';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { authorizeDomainProject } from '@/server/domains/guard';
import { matchesEtag, readSiteImage, readSiteImageType, siteImageHeaders } from '@/server/sites/siteImages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; sha256: string }> };

function notFound(): Response {
  return jsonError('image_not_found', 'This image does not exist on this site.', 404);
}

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId, sha256 } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'viewSite');
  if (!auth.ok) return auth.response;

  if (matchesEtag(req.headers.get('if-none-match'), sha256)) {
    // Checked against the site first, so a 304 never confirms another site's image.
    const type = await readSiteImageType(auth.project.id, sha256);
    if (!type) return notFound();
    return new Response(null, { status: 304, headers: siteImageHeaders(sha256, type, 'private') });
  }
  const image = await readSiteImage(auth.project.id, sha256);
  if (!image) return notFound();
  return new Response(Buffer.from(image.bytes), {
    status: 200,
    headers: { ...siteImageHeaders(sha256, image.contentType, 'private'), 'content-length': String(image.bytes.byteLength) },
  });
}

export const GET = withAuthAvailability(handleGET);
