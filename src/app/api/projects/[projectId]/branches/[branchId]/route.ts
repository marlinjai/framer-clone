// src/app/api/projects/[projectId]/branches/[branchId]/route.ts
//
// One site branch (docs/plans/2026-11-10-site-branches.md, section 6).
//
// GET    /api/projects/<mainId>/branches/<branchId>                      (viewSite) -> { branch }, open or closed
// PATCH  /api/projects/<mainId>/branches/<branchId> { name?, ready? }    (editSite) -> { branch }
// DELETE /api/projects/<mainId>/branches/<branchId>                      (editSite) -> { branch, discarded }
//
// PATCH renames a branch and marks it ready for review or back to open (back to open withdraws an approval).
// A merged or discarded branch answers 410 `branch_closed`. DELETE discards: the branch's content is deleted at
// once, its record stays as `discarded`; a repeat answers the same outcome with `discarded: false`, a merged
// branch answers 410.
//
// Guards: src/server/sites/branches/routeGuard.ts. A branch of another site, or of another company, answers 404.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError, parseBody } from '@/lib/api/respond';
import { SiteRepositoryError, siteRepositoryErrorResponse } from '@/server/sites';
import { getSiteBranchRepository } from '@/server/sites/branches/repository';
import { guardBranchRoute } from '@/server/sites/branches/routeGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; branchId: string }> };

const patchBodySchema = z
  .object({ name: z.string().max(1_000).optional(), ready: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.ready !== undefined, { message: 'name or ready is required' });

const NO_STORE = { 'cache-control': 'no-store' } as const;

function failed(err: unknown, what: string, projectId: string, branchId: string): Response {
  if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
  console.error(`[branches] ${what} of branch ${branchId} of ${projectId} failed:`, err);
  return jsonError('branch_failed', `${what} failed, try again`, 500);
}

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guardBranchRoute(req, 'viewSite');
  if (!guarded.ok) return guarded.response;
  const { projectId, branchId } = await params;
  try {
    const branch = await getSiteBranchRepository().getBranch(guarded.scope, projectId, branchId);
    return Response.json({ branch }, { headers: NO_STORE });
  } catch (err) {
    return failed(err, 'reading', projectId, branchId);
  }
}

async function handlePATCH(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guardBranchRoute(req, 'editSite');
  if (!guarded.ok) return guarded.response;
  const body = await parseBody(req, patchBodySchema);
  if (!body.ok) return body.response;
  const { projectId, branchId } = await params;
  const repo = getSiteBranchRepository();
  try {
    // Both changes in one transaction: a request asking for both gets both or neither.
    const branch = await repo.changeBranch(
      guarded.scope, projectId, branchId, { name: body.data.name, ready: body.data.ready }, { kind: 'user', id: guarded.userId },
    );
    return Response.json({ branch }, { headers: NO_STORE });
  } catch (err) {
    return failed(err, 'changing', projectId, branchId);
  }
}

async function handleDELETE(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guardBranchRoute(req, 'editSite');
  if (!guarded.ok) return guarded.response;
  const { projectId, branchId } = await params;
  try {
    const outcome = await getSiteBranchRepository().discardBranch(guarded.scope, projectId, branchId, {
      kind: 'user',
      id: guarded.userId,
    });
    return Response.json(outcome, { headers: NO_STORE });
  } catch (err) {
    return failed(err, 'discarding', projectId, branchId);
  }
}

export const GET = withAuthAvailability(handleGET);
export const PATCH = withAuthAvailability(handlePATCH);
export const DELETE = withAuthAvailability(handleDELETE);
