// src/app/api/projects/[projectId]/route.ts
//
// PATCH /api/projects/<projectId>   { name, expectedName? } -> rename a project
//
// Renames the project (the `Site.name` row field, which the dashboard lists and
// the editor loads as the project title). Body:
//   - name          the new name; trimmed, 1 to 100 characters, no control
//                   characters (src/lib/projectName.ts, shared with the UI)
//   - expectedName  optional; the name the caller believes is current. When
//                   present the rename only applies while that is still the
//                   stored name, else 409 `name_conflict` with `currentName`
//                   (there is no version column; the name is the precondition)
//
// Guards, in order, the same chain as the other project write routes (save,
// publish), plus the editor-host check of the per-project routes:
//   0. editor host only                              -> else 404 not_found
//   1. a verified auth-brain session                 -> else 401
//      (auth-brain not answering                     -> 503 auth_unavailable)
//   2. the request's active company with the `sites` grant, mapped to its
//      workspace                                     -> else 403
//      (no_active_company / sites_not_enabled)
//   3. `editSite` (workspace admin) on that workspace -> else 401/403
//      (OpenFGA not answering                        -> 503 authz_unavailable)
//   4. the project must be in that workspace         -> else 404 site_not_found
// A project of another company (or another workspace) answers the same 404 as
// a missing one, so existence never leaks. (The custom-domain routes answer
// 403 for that case; this route follows save/publish, which answer 404.)
//
// What a rename does NOT touch: the published address. A site's subdomain is a
// random label allocated on first publish and custom domains are their own
// rows; neither derives from the name, and page URL slugs are per page. The
// published pages do not render the project name either, so a rename changes
// nothing on the live site. Changing an address stays a separate action.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { isEditorHost } from '@/lib/editorHost';
import { jsonError, parseBody } from '@/lib/api/respond';
import { projectNameSchema } from '@/lib/projectName';
import { z } from 'zod';
import {
  getSiteRepository,
  activeScopeDenial,
  resolveActiveScope,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
} from '@/server/sites';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

const renameBodySchema = z.object({
  name: projectNameSchema,
  // Compared verbatim with the stored name, never stored itself, so it takes
  // whatever that name is (including names written before this rule existed).
  expectedName: z.string().optional(),
});

async function handlePATCH(req: Request, { params }: Ctx): Promise<Response> {
  if (!isEditorHost(req.headers.get('host'))) {
    return jsonError('not_found', 'not found', 404);
  }

  const session = await getVerifiedSession(req);
  if (!session) {
    return jsonError('unauthorized', 'authentication required', 401);
  }

  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
  }
  const { scope } = scopeResult;

  const auth = await authenticateRequest(req, scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return jsonError(
      auth.status === 401 ? 'unauthorized' : 'forbidden',
      auth.error,
      auth.status,
    );
  }

  const body = await parseBody(req, renameBodySchema);
  if (!body.ok) return body.response;

  const { projectId } = await params;
  try {
    const renamed = await getSiteRepository().renameSite(
      scope,
      projectId,
      body.data.name,
      body.data.expectedName,
    );
    return Response.json(
      { siteId: projectId, name: renamed.name, updatedAt: renamed.updatedAt.toISOString() },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    console.error(`[projects] rename of ${projectId} failed:`, err);
    return jsonError('rename_failed', 'renaming the project failed, try again', 500);
  }
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const PATCH = withAuthAvailability(handlePATCH);
