// src/app/api/projects/[projectId]/route.ts
//
// PATCH  /api/projects/<projectId>   { name, expectedName? } -> rename a project
// DELETE /api/projects/<projectId>   { confirmName? }        -> delete a project
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
// DELETE removes the project for good (there is no restore): one transaction
// deletes the site row, and the database cascade removes its pages, its domain
// rows (the subdomain, so it answers 404 from then on, and every custom domain,
// whose live claim is released so the proxy host sync drops its route) and its
// experiment references. Company-wide data stays: CMS collections, the commerce
// catalog and orders, Books, the analytics project. A PUBLISHED project needs
// `confirmName` equal to its current name (409 `confirmation_mismatch`
// otherwise). After the commit the published-site caches of the captured
// subdomain and hostnames are invalidated; if that fails the answer is 500
// `delete_cache_failed` (the project is gone, a cached copy may still be
// served until the next deploy), never a quiet success. Permission: `editSite`
// (workspace admin, the same role `publishSite` requires).
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
import { revalidateCustomHostCache, revalidateSiteCache } from '@/server/sites/cachedResolver';
import {
  getSiteRepository,
  activeScopeDenial,
  resolveActiveScope,
  siteRepositoryErrorResponse,
  SiteRepositoryError,
  type DeletedSite,
  type TenantScope,
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

const deleteBodySchema = z.object({ confirmName: z.string().optional() });

type GuardResult =
  | { ok: true; scope: TenantScope }
  | { ok: false; response: Response };

/** Guards 0 to 3 of the header, shared by PATCH and DELETE. */
async function guard(req: Request): Promise<GuardResult> {
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }

  const session = await getVerifiedSession(req);
  if (!session) {
    return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };
  }

  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return { ok: false, response: jsonError(denial.code, denial.message, 403) };
  }
  const { scope } = scopeResult;

  const auth = await authenticateRequest(req, scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return {
      ok: false,
      response: jsonError(auth.status === 401 ? 'unauthorized' : 'forbidden', auth.error, auth.status),
    };
  }
  return { ok: true, scope };
}

async function handlePATCH(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guard(req);
  if (!guarded.ok) return guarded.response;
  const { scope } = guarded;

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

async function handleDELETE(req: Request, { params }: Ctx): Promise<Response> {
  const guarded = await guard(req);
  if (!guarded.ok) return guarded.response;
  const { scope } = guarded;

  // The body is optional (an unpublished project needs no confirmation).
  let confirmName: string | undefined;
  const raw = await req.text();
  if (raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonError('bad_json', 'invalid JSON body', 400);
    }
    const result = deleteBodySchema.safeParse(parsed);
    if (!result.success) {
      return jsonError('bad_body', 'invalid request body', 400, { issues: result.error.issues });
    }
    confirmName = result.data.confirmName;
  }

  const { projectId } = await params;
  let deleted: DeletedSite;
  try {
    deleted = await getSiteRepository().deleteSite(scope, projectId, { confirmName });
  } catch (err) {
    if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
    console.error(`[projects] delete of ${projectId} failed:`, err);
    return jsonError('delete_failed', 'deleting the project failed; nothing was deleted, try again', 500);
  }

  // After the commit: stop serving cached copies on the subdomain and every
  // custom hostname at once. Cached custom-host hits never expire on their
  // own, so a failure must be loud.
  try {
    if (deleted.subdomain) revalidateSiteCache(deleted.subdomain);
    for (const hostname of deleted.hostnames) revalidateCustomHostCache(hostname);
  } catch (err) {
    console.error(
      `[projects] deleted ${projectId}, but invalidating the cache of ${[deleted.subdomain, ...deleted.hostnames].filter(Boolean).join(', ')} failed:`,
      err,
    );
    return jsonError(
      'delete_cache_failed',
      'The project was deleted, but its published pages may still be served from cache until the next deploy.',
      500,
    );
  }

  console.info(
    `[projects] deleted ${projectId} ("${deleted.name}", ${deleted.wasPublished ? 'published' : 'unpublished'}; released ${deleted.hostnames.length} custom hostname(s))`,
  );
  return Response.json(
    {
      siteId: projectId,
      deleted: true,
      subdomain: deleted.subdomain,
      releasedHostnames: deleted.hostnames,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const PATCH = withAuthAvailability(handlePATCH);
export const DELETE = withAuthAvailability(handleDELETE);
