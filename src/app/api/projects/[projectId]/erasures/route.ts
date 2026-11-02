// src/app/api/projects/[projectId]/erasures/route.ts
//
// POST /api/projects/<projectId>/erasures
//      { value, caseSensitive?, insideWords?, replacement?, token, chosen }
//   -> erase one personal value from every kept revision and the working copy,
//      then search again and answer what is left (the proof).
// GET  /api/projects/<projectId>/erasures
//   -> the site's erasures, newest first: who, when, the places changed. Never
//      the value.
//
// The company's owner only (see _shared.ts). Plan:
// docs/plans/2026-11-01-immutable-published-copy.md, "Erasing personal data from
// the history". Failures use the Track-0 envelope: 400 a value or replacement
// outside the bounds, 403 not the owner, 404 unknown site, 409
// `erase_preview_stale` (search again) or `nothing_to_erase`, 500 otherwise. A
// failed erase changed nothing and is simply repeated.
//
// The published site is refreshed after every attempt that got past the guard,
// also one answered `nothing_to_erase`: when a refresh failed after a committed
// erase, repeating the erase finds nothing and refreshes again.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError, parseBody } from '@/lib/api/respond';
import { getSiteRepository, NothingToEraseError, type PersonalDataErasure } from '@/server/sites';
import { authorizeEraser, eraseBodySchema, eraseErrorResponse, queryOf, revalidateErasedSite } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeEraser(req, projectId);
  if (!auth.ok) return auth.response;

  const { id, workspaceId, tenantGroupId } = auth.project;
  try {
    const erasures = await getSiteRepository().listErasures({ workspaceId, tenantGroupId }, id);
    return Response.json({ erasures }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return eraseErrorResponse(err, 'erasures_failed', 'Failed to list the erasures.');
  }
}

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeEraser(req, projectId);
  if (!auth.ok) return auth.response;

  const body = await parseBody(req, eraseBodySchema);
  if (!body.ok) return body.response;

  const { id, workspaceId, tenantGroupId } = auth.project;
  const scope = { workspaceId, tenantGroupId };
  const query = queryOf(body.data);
  const repo = getSiteRepository();

  let erasure: PersonalDataErasure | null = null;
  let failure: Response | null = null;
  try {
    erasure = await repo.erasePersonalData(scope, id, {
      query,
      replacement: body.data.replacement,
      token: body.data.token,
      chosen: body.data.chosen,
      erasedBy: auth.userId,
    });
  } catch (err) {
    failure = eraseErrorResponse(err, 'erase_failed', 'The erase failed. Nothing was changed; try again.');
    if (!(err instanceof NothingToEraseError)) return failure;
  }

  try {
    await revalidateErasedSite(id);
  } catch (err) {
    console.error(`[erase] cache refresh failed: ${err instanceof Error ? err.name : 'unknown error'}`);
    return jsonError(
      'erase_cache_refresh_failed',
      erasure
        ? 'The data was erased, but the published site could not be refreshed. Erase again with the same search to refresh it.'
        : 'The published site could not be refreshed. Try again.',
      500,
    );
  }
  if (!erasure) return failure as Response;

  // The proof: a fresh search after the commit, for this exact text only. Matches
  // still found are blocked ones, ones not ticked, or ones a publish added since.
  let remaining: number | null = null;
  let erasableRemaining: number | null = null;
  try {
    const after = await repo.searchPersonalData(scope, id, query);
    remaining = after.total;
    erasableRemaining = after.erasable;
  } catch (err) {
    console.error(`[erase] proof search failed: ${err instanceof Error ? err.name : 'unknown error'}`);
  }

  return Response.json(
    {
      erasureId: erasure.erasureId,
      erased: erasure.erased,
      places: erasure.places,
      remaining,
      erasableRemaining,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export const GET = withAuthAvailability(handleGET);
export const POST = withAuthAvailability(handlePOST);
