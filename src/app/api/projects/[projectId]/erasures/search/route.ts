// src/app/api/projects/[projectId]/erasures/search/route.ts
//
// POST /api/projects/<projectId>/erasures/search  { value, caseSensitive?, insideWords? }
//   -> every match of one personal value in the site's kept revisions and its
//      working copy, with where it is, a short excerpt, whether it may be
//      rewritten, and the token the erase must repeat (the erase preview).
//
// A POST, although it changes nothing: the value is personal data and must not
// land in an address or an access log. The company's owner only (see
// ../_shared.ts). Plan: docs/plans/2026-11-01-immutable-published-copy.md,
// "Erasing personal data from the history". Failures use the Track-0 envelope:
// 400 a value outside the bounds, 403 not the owner, 404 unknown site, 500
// otherwise.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { parseBody } from '@/lib/api/respond';
import { getSiteRepository } from '@/server/sites';
import { authorizeEraser, eraseErrorResponse, queryOf, searchBodySchema } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeEraser(req, projectId);
  if (!auth.ok) return auth.response;

  const body = await parseBody(req, searchBodySchema);
  if (!body.ok) return body.response;

  const { id, workspaceId, tenantGroupId } = auth.project;
  try {
    const search = await getSiteRepository().searchPersonalData({ workspaceId, tenantGroupId }, id, queryOf(body.data));
    return Response.json(search, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return eraseErrorResponse(err, 'erase_search_failed', 'The search failed. Nothing was changed.');
  }
}

export const POST = withAuthAvailability(handlePOST);
