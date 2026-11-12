// src/app/api/projects/[projectId]/branches/[branchId]/preview-link/route.ts
//
// The public preview link of a branch (site branches, slice S8,
// docs/plans/2026-11-10-site-branches.md, section 7).
//
//   GET     whether the branch has a link, until when, who made it. Never the
//           address: only a hash of its token is stored. Needs `viewSite`.
//   POST    make the link, replacing the one the branch had (the old address
//           stops working at once). Answers the address, this one time. Needs
//           `editSite`: it puts unpublished content where anyone with the
//           address can read it.
//   DELETE  revoke it. Needs `editSite`.
//
// Editor host, a signed-in person, the per-company switch, as every branch
// route (guardBranchRoute). An agent key cannot make a public link: what
// leaves the company is a person's decision.

import { z } from 'zod';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { jsonError, parseBody } from '@/lib/api/respond';
import { SiteRepositoryError, siteRepositoryErrorResponse } from '@/server/sites';
import { getSiteBranchPreviewLinks, PREVIEW_LINK_DAYS, PREVIEW_LINK_DEFAULT_DAYS, type PreviewLinkDays } from '@/server/sites/branches/previewLinks';
import { guardBranchRoute } from '@/server/sites/branches/routeGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string; branchId: string }> };

const postBodySchema = z.object({
  days: z
    .number()
    .refine((d): d is PreviewLinkDays => (PREVIEW_LINK_DAYS as readonly number[]).includes(d), { message: `days is one of ${PREVIEW_LINK_DAYS.join(', ')}` })
    .optional(),
});

const NO_STORE = { 'cache-control': 'no-store' } as const;

function failed(err: unknown, what: string, projectId: string, branchId: string): Response {
  if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
  console.error(`[branches] ${what} the preview link of branch ${branchId} of ${projectId} failed:`, err);
  return jsonError('preview_link_failed', `${what} the preview link failed, try again`, 500);
}

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guardBranchRoute(req, 'viewSite');
  if (!guarded.ok) return guarded.response;
  const { projectId, branchId } = await params;
  try {
    const link = await getSiteBranchPreviewLinks().get(guarded.scope, projectId, branchId);
    return Response.json({ link }, { headers: NO_STORE });
  } catch (err) {
    return failed(err, 'reading', projectId, branchId);
  }
}

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guardBranchRoute(req, 'editSite');
  if (!guarded.ok) return guarded.response;
  const body = await parseBody(req, postBodySchema);
  if (!body.ok) return body.response;
  const { projectId, branchId } = await params;
  try {
    const link = await getSiteBranchPreviewLinks().create(
      guarded.scope,
      projectId,
      branchId,
      { kind: 'user', id: guarded.userId },
      body.data.days ?? PREVIEW_LINK_DEFAULT_DAYS,
    );
    return Response.json({ link }, { status: 201, headers: NO_STORE });
  } catch (err) {
    return failed(err, 'making', projectId, branchId);
  }
}

async function handleDELETE(req: Request, { params }: Ctx): Promise<Response> {
  // Ending something works with site branches switched off too (routeGuard, step 3).
  const guarded = await guardBranchRoute(req, 'editSite', { endsOnly: true });
  if (!guarded.ok) return guarded.response;
  const { projectId, branchId } = await params;
  try {
    const revoked = await getSiteBranchPreviewLinks().revoke(guarded.scope, projectId, branchId, { kind: 'user', id: guarded.userId });
    return Response.json({ revoked }, { headers: NO_STORE });
  } catch (err) {
    return failed(err, 'revoking', projectId, branchId);
  }
}

export const GET = withAuthAvailability(handleGET);
export const POST = withAuthAvailability(handlePOST);
export const DELETE = withAuthAvailability(handleDELETE);
