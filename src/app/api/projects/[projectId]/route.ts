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
// experiment references. The project's form submissions live in the company's
// tenant schema, out of the cascade's reach, so they are deleted right after the
// commit (src/server/forms/projectDelete.ts); if that fails the answer is 500
// `delete_submissions_failed` (the project is gone, its submissions are not),
// never a quiet success. Company-wide data stays: CMS collections, the commerce
// catalog and orders, Books, the analytics project. A PUBLISHED project needs
// `confirmName` equal to its current name (409 `confirmation_mismatch`
// otherwise). After the commit the published-site caches of the captured
// subdomain and hostnames are invalidated; if that fails the answer is 500
// `delete_cache_failed` (the project is gone, a cached copy may still be
// served until the next deploy), never a quiet success; a second invalidation
// runs a few seconds later to catch a request that cached the site during the
// commit. Permission: `editSite` plus `publishSite` and `manageDomain` (taking
// a site offline, releasing its domains). The proxy host sync drops released
// routes within a minute, unless its drop protection holds a large drop
// (deploy/README.md): the routes then stay until an operator confirms, but the
// app answers 404 for them, as it does for any host it has no claim for.
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
import { checkWorkspaceAccess } from '@/lib/auth-check';
import type { FramerAction } from '@/lib/permissions';
import { jsonError, parseBody } from '@/lib/api/respond';
import { projectNameSchema } from '@/lib/projectName';
import { z } from 'zod';
import { revalidateCustomHostCache, revalidateSiteCache } from '@/server/sites/cachedResolver';
import { deleteProjectSubmissions } from '@/server/forms/projectDelete';
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

/**
 * Guards 0 to 3 of the header, shared by PATCH and DELETE. `alsoRequires`
 * adds permissions on top of `editSite` (all of them `workspace.admin` today,
 * but each action may be tightened on its own later).
 */
async function guard(req: Request, alsoRequires: FramerAction[] = []): Promise<GuardResult> {
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
  for (const action of alsoRequires) {
    if (!(await checkWorkspaceAccess(auth.userId, scope.workspaceId, action))) {
      return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };
    }
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

/** Delay of the second cache invalidation after a delete. */
const LATE_INVALIDATION_MS = 5_000;

/** Invalidate every captured host; returns the hosts whose invalidation threw. */
function invalidateDeletedHosts(deleted: DeletedSite): string[] {
  const failed: string[] = [];
  const attempt = (host: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      failed.push(host);
      console.error(`[projects] invalidating the cache of ${host} after deleting ${deleted.siteId} failed:`, err);
    }
  };
  if (deleted.subdomain) {
    const sub = deleted.subdomain;
    attempt(sub, () => revalidateSiteCache(sub));
  }
  for (const hostname of deleted.hostnames) attempt(hostname, () => revalidateCustomHostCache(hostname));
  return failed;
}

async function handleDELETE(req: Request, { params }: Ctx): Promise<Response> {
  // Deleting takes a site offline and releases its domains: on top of
  // editSite it needs what unpublishing and disconnecting a domain need.
  const guarded = await guard(req, ['publishSite', 'manageDomain']);
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
  // own, so a failure must be loud. Every host is tried even when one fails.
  const failed = invalidateDeletedHosts(deleted);
  // A visitor request that read the site just BEFORE the commit can store its
  // (stale) result just AFTER the invalidation above, and nothing would ever
  // invalidate that host again. A second pass a few seconds later closes that
  // window (the server is a long-running Node process).
  setTimeout(() => {
    const late = invalidateDeletedHosts(deleted);
    if (late.length > 0) console.error(`[projects] late cache invalidation after deleting ${projectId} failed for: ${late.join(', ')}`);
  }, LATE_INVALIDATION_MS).unref?.();

  // Then the form submissions the cascade cannot reach (another schema, another
  // connection): after the caches, so the site stops answering first, and
  // before answering, so a failure is loud. The submit endpoint reads the site
  // uncached, so no submission can land after the commit.
  let submissionsFailed = false;
  let submissionsDeleted = 0;
  try {
    submissionsDeleted = await deleteProjectSubmissions(scope.tenantGroupId, projectId);
  } catch (err) {
    submissionsFailed = true;
    console.error(`[projects] deleting the form submissions of ${projectId} failed:`, err);
  }
  if (submissionsFailed) {
    return jsonError(
      'delete_submissions_failed',
      'The project was deleted, but its form submissions could not be deleted. Contact support to have them removed.',
      500,
    );
  }
  if (failed.length > 0) {
    return jsonError(
      'delete_cache_failed',
      'The project was deleted, but its published pages may still be served from cache until the next deploy.',
      500,
    );
  }

  console.info(
    `[projects] deleted ${projectId} ("${deleted.name}", ${deleted.wasPublished ? 'published' : 'unpublished'}; released ${deleted.hostnames.length} custom hostname(s); deleted ${submissionsDeleted} form submission(s))`,
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
