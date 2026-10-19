import 'server-only';

// src/server/cms/readScope.ts
//
// Decides WHOSE CMS data a /api/cms/* READ may return, from the request alone.
// Before this, the four GET routes read through `getCmsRepository()` with no
// argument, i.e. the constant single-tenant workspace, on every host and with no
// session check at all (reviewer finding, 2026-10-19). The read is now split
// into the same two planes commerce uses (multi-tenancy phase 2 plan, decisions
// D2 and D4):
//
//   EDITOR host (src/lib/editorHost.ts; localhost and an unset EDITOR_HOST count
//   as the editor, so local development is unchanged):
//     1. a verified auth-brain session is required          -> else 401 unauthorized
//     2. the request's ACTIVE company is resolved through the shared
//        resolveActiveScope (company selector honoured only for a company of
//        the session holding the `sites` grant) and mapped to that company's
//        editor workspace         -> else 403 sites_not_enabled / no_active_company
//     3. the session must hold `viewSite` on that workspace (a read, so the
//        read permission; the CMS writes check `editSite` the same way)
//                                                           -> else 403 forbidden
//        (OpenFGA failing to answer throws AuthzUnavailableError, auth-brain
//        failing to answer throws AuthUnavailableError; the route's
//        withAuthAvailability wrapper turns either into a JSON 503)
//     4. reads run on getCmsRepository(<active workspace>).
//
//   Any OTHER host is the published-site plane:
//     1. the Host must resolve to a PUBLISHED site (the same cached resolver the
//        storefront render uses)                            -> else 404 not_found
//     2. reads run on getPublishedCmsRepository(<that site's workspace>): only
//        published, non-archived rows, at most 100 per page, the same rule the
//        storefront render uses (src/server/cms/publishedVisibility.ts).
//     The session is NEVER read on this plane: the apex `.lumitra.co` session
//     cookie still reaches `*.sites.lumitra.co`, and a published site's own
//     script must not be able to read its visitor's editor workspace through it
//     (D2). An unknown host answers 404 rather than commerce's 403: from the
//     outside, the CMS simply does not exist on a host that is not a site.
//
// Scope on the published plane is the site's WORKSPACE, not the narrower "only
// the collections the site's pages bind": a binding's collection id may be a
// template expression resolved per render, so deriving the bound set means
// evaluating every page snapshot, which is not a cheap per-request check.
//
// Isolation inside a workspace is the repository's job (src/server/cms/
// repository.ts): a collection or row id from another workspace resolves to
// "not found", so a foreign id answers the same 404 as a missing one and never
// leaks existence.

import { jsonError } from '@/lib/api/respond';
import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { isEditorHost } from '@/lib/editorHost';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites';
import { getCachedPublishedSite } from '@/server/sites/cachedResolver';
import {
  getCmsRepository,
  getPublishedCmsRepository,
  type CmsReadRepository,
} from './repository';

export type CmsReadContext =
  | {
      ok: true;
      /** Which plane decided the workspace (for logs and tests). */
      plane: 'editor' | 'published';
      workspaceId: string;
      /** The read repository bound to `workspaceId`; derive once per request. */
      repo: CmsReadRepository;
    }
  | { ok: false; response: Response };

// The editor reads everything of its workspace (drafts included, it is where
// they are written); a published site reads only what is published
// (getPublishedCmsRepository: published, non-archived rows, pages capped at
// PUBLISHED_MAX_LIMIT, by-id lookups inside the requested table only).
function ok(plane: 'editor' | 'published', workspaceId: string): CmsReadContext {
  const repo =
    plane === 'published' ? getPublishedCmsRepository(workspaceId) : getCmsRepository(workspaceId);
  return { ok: true, plane, workspaceId, repo };
}

/**
 * Resolve the CMS read context for a request. Returns the workspace-bound read
 * repository, or the ready 401 / 403 / 404 response. AuthUnavailableError and
 * AuthzUnavailableError propagate (the caller wraps the route in
 * withAuthAvailability); any other failure (database down) also throws, so the
 * route surfaces it as its own error envelope.
 */
export async function resolveCmsReadContext(req: Request): Promise<CmsReadContext> {
  const host = req.headers.get('host');

  if (!isEditorHost(host)) {
    const site = await getCachedPublishedSite(host);
    if (!site) {
      return { ok: false, response: jsonError('not_found', 'not found', 404) };
    }
    return ok('published', site.workspaceId);
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
  const { workspaceId } = scopeResult.scope;
  const allowed = await checkWorkspaceAccess(session.user.id, workspaceId, 'viewSite');
  if (!allowed) {
    return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };
  }
  return ok('editor', workspaceId);
}
