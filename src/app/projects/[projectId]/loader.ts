import 'server-only';

// src/app/projects/[projectId]/loader.ts
//
// The server-side loader for the per-project editor route (MT-10), extracted
// from the page so the isolation + auth-bounce + 404 contract is unit-testable
// without rendering a server component.
//
// HARD ISOLATION: the workspace the project is loaded under is derived from the
// SERVER-verified auth-brain session (the request's active company, which must
// hold the auth-brain app grant `sites` -> that company's workspace -> its
// tenant_group), never from a client-supplied scope or the loaded MST tree. The
// app-local `framer_company` selector only chooses among the granted companies
// the verified session contains (resolveActiveScope). `loadProject` filters by `workspace_id`, so a `projectId`
// that lives in ANOTHER workspace is indistinguishable from a missing one: it
// throws `SiteNotFoundError`, which this loader maps to a `not_found` result the
// page turns into `notFound()`. A foreign tenant's project is NEVER rendered.
//
// FAIL-CLOSED: a missing cookie or an invalid/expired session (verify -> null)
// resolves to `unauthenticated` carrying the auth-brain login URL. auth-brain
// failing to answer (network error, 5xx) resolves to `auth_unavailable`: the
// page shows a retry notice, never the login. A VALID session with no
// resolvable company (none picked, or none with Lumitra Sites) resolves to
// `choose_company` carrying the dashboard URL (with this path as `next`), where
// the chooser or the not-enabled page renders; NEVER the login: auth-brain
// would see the valid session and send the user straight back, the endless
// redirect loop of 2026-10-19.

import { cookies, headers } from 'next/headers';
import { getSnapshot } from 'mobx-state-tree';
import {
  AuthUnavailableError,
  verifySessionOrThrowUnavailable,
} from '@/lib/authBrainAvailability';
import { companySelectorsFromJar } from '@/lib/activeCompanyCookie';
import {
  getSiteRepository,
  listCompanyChoices,
  resolveActiveScope,
  SiteNotFoundError,
} from '@/server/sites';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';
import type { SiteAddress } from '@/contexts/SiteAddressContext';

// Same default + cookie name the rest of the app uses (auth-brain.ts /
// auth-api.ts / the MT-09 dashboard loader). The build has no runtime env; this
// default keeps it green.
const AUTH_BRAIN_URL = process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co';
const SESSION_COOKIE = 'lumitra_session';

export type { SiteAddress };

export type ProjectLoadResult =
  | { status: 'unauthenticated'; loginUrl: string }
  | { status: 'auth_unavailable' }
  | { status: 'choose_company'; chooserUrl: string }
  | { status: 'not_found' }
  | { status: 'ok'; snapshot: ProjectSnapshotOut; site: SiteAddress };

/**
 * Build the auth-brain login URL whose `return_to` brings the user back to this
 * exact project editor after authenticating — consistent with the middleware
 * bounce contract (proto + forwarded host + path), and matching the MT-09
 * dashboard loader's shape.
 */
async function buildLoginUrl(
  projectId: string,
  returnPathSuffix: string,
): Promise<string> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') || 'https';
  const host = h.get('x-forwarded-host') || h.get('host') || '';
  const returnTo = `${proto}://${host}/projects/${projectId}${returnPathSuffix}`;

  const loginUrl = new URL('/login', AUTH_BRAIN_URL);
  loginUrl.searchParams.set('return_to', returnTo);
  return loginUrl.toString();
}

/**
 * The dashboard chooser URL that continues to this project (or its preview)
 * once a company is chosen. `switchMode` forces the chooser even though a
 * company is active (the project lives in another of the caller's companies);
 * without it the dashboard would forward straight back here.
 */
function chooserUrlFor(
  projectId: string,
  returnPathSuffix: string,
  { switchMode }: { switchMode: boolean },
): string {
  const next = `/projects/${encodeURIComponent(projectId)}${returnPathSuffix}`;
  return `/projects?${switchMode ? 'switch=1&' : ''}next=${encodeURIComponent(next)}`;
}

/**
 * Resolve the editor's data for `/projects/<projectId>`: the workspace-scoped
 * project serialized to a snapshot the client editor hydrates, OR a fail-closed
 * `unauthenticated`/`not_found` result. The page is the only thing that
 * performs the redirect / `notFound()`.
 *
 * `returnPathSuffix` is appended to the `return_to` so a consumer route deeper
 * than the editor (e.g. the MT-11 preview at `/projects/<id>/preview`) bounces
 * the user back to ITSELF after login, not the editor. Defaults to '' (editor).
 */
export async function loadProjectSnapshot(
  projectId: string,
  returnPathSuffix = '',
): Promise<ProjectLoadResult> {
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE)?.value;

  let session = null;
  if (cookie) {
    try {
      session = await verifySessionOrThrowUnavailable(cookie);
    } catch (err) {
      // auth-brain could not answer. NOT "signed out": sending the user to the
      // login would loop (auth-brain, once back, sees the valid session). The
      // page renders a retry notice instead.
      if (err instanceof AuthUnavailableError) {
        console.error('[auth] auth-brain unavailable during session verify', err.cause);
        return { status: 'auth_unavailable' };
      }
      throw err;
    }
  }
  if (!session) {
    return { status: 'unauthenticated', loginUrl: await buildLoginUrl(projectId, returnPathSuffix) };
  }

  // Scope is derived from the SERVER session only. No resolvable company ->
  // the dashboard (chooser or not-enabled page), never the login, never a
  // guessed company.
  const scopeResult = resolveActiveScope(session, companySelectorsFromJar(jar));
  if (!scopeResult.ok) {
    return {
      status: 'choose_company',
      chooserUrl: chooserUrlFor(projectId, returnPathSuffix, { switchMode: false }),
    };
  }

  try {
    // workspace_id is in loadProject's where-clause: a cross-workspace id throws
    // SiteNotFoundError here, indistinguishable from a missing site, so a
    // foreign tenant's existence never leaks and its project is never rendered.
    const repo = getSiteRepository();
    const project = await repo.loadProject(scopeResult.scope, projectId);
    const snapshot = getSnapshot(project) as ProjectSnapshotOut;
    // Where the site lives, for the page settings URL preview and its
    // "old links will redirect" note. Same scope, so it cannot leak either.
    const { host, everPublished } = await repo.getSiteAddress(scopeResult.scope, projectId);
    return { status: 'ok', snapshot, site: { host, everPublished } };
  } catch (err) {
    if (err instanceof SiteNotFoundError) {
      // The link may point at a project of ANOTHER of the caller's companies
      // with Lumitra Sites (shared link, or the company was switched in
      // another tab). Look only among those companies' workspaces; when it is
      // there, offer the chooser (forced, with this path as `next`) instead of
      // a 404. A site of a company without the grant, or outside the session,
      // stays a plain 404: there is no company to switch to, and the lookup is
      // restricted to the caller's own companies, so nothing leaks.
      const others = listCompanyChoices(session)
        .filter((c) => c.id !== scopeResult.companyId)
        .map((c) => c.workspaceId);
      if (others.length > 0) {
        const home = await getSiteRepository().findSiteWorkspaceAmong(projectId, others);
        if (home) {
          return {
            status: 'choose_company',
            chooserUrl: chooserUrlFor(projectId, returnPathSuffix, { switchMode: true }),
          };
        }
      }
      return { status: 'not_found' };
    }
    // Any other failure is a genuine 500 — do not swallow it into a 404.
    throw err;
  }
}
