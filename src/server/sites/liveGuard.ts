import 'server-only';

// src/server/sites/liveGuard.ts
//
// The guard of the live sync routes (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 1): GET /api/projects/<id>/events and GET /api/projects/<id>/document.
// Both hand the open editor what its save writes, so they take the save route's
// chain, plus the editor-host check of the per-project routes:
//   0. editor host only                              -> else 404 not_found
//   1. a verified auth-brain session cookie          -> else 401
//      (auth-brain not answering                     -> 503 auth_unavailable, thrown
//       for withAuthAvailability)
//   2. the request's active company with the `sites` grant, mapped to its
//      workspace                                     -> else 403
//      (no_active_company / sites_not_enabled)
//   3. `editSite` on that workspace                  -> else 403
//      (OpenFGA not answering                        -> 503 authz_unavailable, thrown)
//   4. the project in that workspace                 -> else 404 site_not_found
// A project of another company or workspace answers the same 404 as a missing
// one, so existence never leaks. This follows the save and rename routes (404),
// not the domain routes' shared guard (src/server/domains/guard.ts, 403 for both),
// because the editor that calls these already treats a 404 as "this project is gone".
//
// `EventSource` cannot set headers, so the session cookie is the only credential;
// the request is same-origin, so the browser sends it.
//
// Memo (decided 2026-11-09, plan section "Decisions"): an open editor calls this
// for its stream, for every re-check of that stream and for every document
// fetch after a write, and several tabs of one session do it at once. Step 1 is
// already cached by the auth-brain client for 30 s (src/lib/auth-brain.ts,
// `cacheTtlMs`); step 3, the OpenFGA check, is not, so this module remembers an
// allowed `editSite` for at most LIVE_GUARD_MEMO_MS (30 s), keyed by the SHA-256
// of the session cookie (never the cookie itself) plus the workspace step 2
// resolved from the verified session (the company-selector cookie only picks
// among the session's own companies, and its choice is part of the key, so it
// never aliases). Step 1 still runs first on every call, so a session auth-brain
// no longer accepts is refused before the memo is asked. A NO or an outage is
// never remembered, and steps 0, 2 and 4 run on every call (step 4 reads the
// version fresh, which the document route's ETag and body cache depend on). The
// price is revocation latency: an `editSite` taken away is still accepted for up
// to 30 s by these routes (as a signed-out or expired session already is
// through the client's own cache, on every guarded route); a stream notices at its next re-check after that. The map
// is bounded (LIVE_GUARD_MEMO_MAX entries, the oldest goes first).

import { createHash } from 'node:crypto';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import { readCompanySelectors, readRequestCookie } from '@/lib/activeCompanyCookie';
import { carriesBearer } from '@/lib/bearer';
import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { isEditorHost } from '@/lib/editorHost';
import { jsonError } from '@/lib/api/respond';
import { getSiteRepository, type SiteRepository } from './repository';
import { activeScopeDenial, resolveActiveScope } from './scope';
import { BranchClosedError, SiteNotFoundError, siteRepositoryErrorResponse } from './errors';
import type { TenantScope } from './repository';

/** How long an allowed `editSite` is remembered, at most. */
export const LIVE_GUARD_MEMO_MS = 30_000;
/** Entries the memo keeps at once; the oldest goes first. */
export const LIVE_GUARD_MEMO_MAX = 5000;

const SESSION_COOKIE = 'lumitra_session';

const MEMO_KEY = Symbol.for('lumitra.liveGuardMemo');

/** `${cookie hash}:${workspaceId}` to until when its yes holds, least recently stored first. */
function memo(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  let m = g[MEMO_KEY];
  if (!m) {
    m = new Map();
    g[MEMO_KEY] = m;
  }
  return m;
}

/** The memo key of the request's session: a hash of its cookie, or null when it has none (or is a machine request). */
function sessionHash(req: Request): string | null {
  if (carriesBearer(req)) return null;
  const cookie = readRequestCookie(req, SESSION_COOKIE);
  return cookie ? createHash('sha256').update(cookie).digest('base64url') : null;
}

/** Step 3, remembered: an allowed `editSite` on the workspace is reused for LIVE_GUARD_MEMO_MS. */
async function mayEdit(userId: string, workspaceId: string, hash: string | null, now: number): Promise<boolean> {
  const m = memo();
  const key = hash ? `${hash}:${workspaceId}` : null;
  if (key) {
    const until = m.get(key);
    if (until !== undefined && until > now) return true;
    if (until !== undefined) m.delete(key);
  }
  const allowed = await checkWorkspaceAccess(userId, workspaceId, 'editSite');
  if (allowed && key) {
    m.delete(key);
    m.set(key, now + LIVE_GUARD_MEMO_MS);
    while (m.size > LIVE_GUARD_MEMO_MAX) m.delete(m.keys().next().value as string);
  }
  return allowed;
}

/** Tests only: forget every remembered permission. */
export function resetLiveGuardMemoForTests(): void {
  memo().clear();
}

export type LiveProjectResult =
  | { ok: true; scope: TenantScope; session: SessionVerifyResponse; version: number }
  | { ok: false; response: Response };

/**
 * Run the chain for a project. Throws AuthUnavailableError or AuthzUnavailableError
 * when auth-brain or OpenFGA cannot answer (the route's withAuthAvailability turns
 * them into a 503); every other refusal is a response.
 */
export async function authorizeLiveProject(
  req: Request,
  projectId: string,
  repository: SiteRepository = getSiteRepository(),
): Promise<LiveProjectResult> {
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }
  const session = await getVerifiedSession(req);
  if (!session) return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };

  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return { ok: false, response: jsonError(denial.code, denial.message, 403) };
  }
  const { scope } = scopeResult;

  const allowed = await mayEdit(session.user.id, scope.workspaceId, sessionHash(req), Date.now());
  if (!allowed) return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };

  try {
    const version = await repository.getSiteVersion(scope, projectId);
    return { ok: true, scope, session, version };
  } catch (err) {
    // A merged or discarded branch: 410 `branch_closed`, so its open editor can say what happened.
    if (err instanceof BranchClosedError) return { ok: false, response: siteRepositoryErrorResponse(err) };
    if (err instanceof SiteNotFoundError) {
      return { ok: false, response: jsonError('site_not_found', 'no such project', 404) };
    }
    throw err;
  }
}
