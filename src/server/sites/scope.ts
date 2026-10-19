import 'server-only';

// src/server/sites/scope.ts
//
// Resolve a TenantScope (workspace_id + tenant_group_id) from a verified
// auth-brain session. This is the bridge between the consuming-app session
// contract and the persistence layer's hard isolation boundary: the scope is
// derived from the SERVER-verified session, never from anything the client
// sends, so a request can only ever read/write within a workspace the caller
// is actually a member of.
//
// framer-clone models no identity: the tenant_group -> tenant (company) ->
// workspace hierarchy is owned by auth-brain and arrives on the
// SessionVerifyResponse.
//
// THE EDITOR WORKS PER COMPANY (decided 2026-10-19). The user picks a COMPANY
// (an auth-brain tenant), never a workspace, and only companies holding the
// auth-brain app grant `sites` may use the editor at all (like Lumitra Studio
// with `studio`). The company's sites still live in a workspace (Site rows keep
// their workspace_id, nothing is migrated), so every request maps the active
// company to exactly one workspace of the session (companyWorkspaceId) and the
// authorization stays exactly as before on that workspace
// (resolveScopeForWorkspace here, checkWorkspaceAccess / OpenFGA in the routes).
//
// The rules, each written down because the UI no longer explains them:
//
//   - A company QUALIFIES when it is in the session's direct `tenants[]` AND its
//     `app_grants` contains `sites`. Inherited companies (`inherited_tenants`)
//     do not count, matching Studio and the auth-brain portal.
//   - A tenant entry with no `app_grants` field at all is an older auth-brain
//     build (version skew): failed closed like "not granted", but logged once
//     with a distinct, greppable line so a rollback is diagnosable.
//   - A company is USABLE when it qualifies AND the session lists at least one
//     workspace of it (the user is a workspace member there). A granted company
//     without a workspace for this user cannot open any site, so it is never
//     offered and never resolved; the not-enabled page names it separately.
//   - The company's workspace: today every company has exactly one ("main", or
//     "whiz-art-media" for Whiz-Art Media). Should one ever have several, the
//     one with slug `main` wins, else the oldest by `created_at`, ties broken
//     by id. Deterministic, so the same company always opens the same sites.
//     There is no workspace picker in the UI any more.

// Import the session type from the SDK (which re-exports it) rather than the
// transitive-only `@marlinjai/auth-brain-shared`, matching how permissions.ts
// imports its SDK types. Keeps the dependency surface to the single declared
// dep (`@marlinjai/auth-brain-sdk`).
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import type { TenantScope } from './repository';

/** The auth-brain app grant a company needs to use the editor. */
export const SITES_APP = 'sites';

/** The distinct line logged when a verify response carries no `app_grants`. */
export const APP_GRANT_SKEW_MESSAGE =
  'verify response carried no app_grants field (auth-brain version skew?)';

/**
 * The reason a session could not be resolved to a scope, for a precise route
 * response (vs. a single opaque failure).
 *
 *   - `sites_not_enabled`: none of the session's companies holds the `sites`
 *     grant (the same condition on which the dashboard shows "Lumitra Sites is
 *     not enabled for your companies").
 *   - `no_active_company`: at least one company holds the grant, but none could
 *     be chosen without asking (several usable companies and no selection, or
 *     the granted companies have no workspace for this user).
 *   - `workspace_not_in_session` / `tenant_not_in_session`: an explicit
 *     workspace (resolveScopeForWorkspace) the session does not contain.
 */
export type ScopeResolutionError =
  | 'sites_not_enabled'
  | 'no_active_company'
  | 'workspace_not_in_session'
  | 'tenant_not_in_session';

export type ScopeResult =
  | { ok: true; scope: TenantScope }
  | { ok: false; error: ScopeResolutionError };

/** The active-company scope: the workspace scope plus the company it came from. */
export type ActiveScopeResult =
  | { ok: true; scope: TenantScope; companyId: string }
  | { ok: false; error: ScopeResolutionError };

/**
 * The raw selector cookies of a request. Both are SELECTORS, never credentials:
 * every value is re-checked against the verified session here.
 *
 *   - `companyCookie`: the `framer_company` cookie (a tenant id).
 *   - `legacyWorkspaceCookie`: the retired `framer_ws` cookie (a workspace id),
 *     honoured only as a fallback until the dashboard migrates it once.
 */
export interface CompanySelectors {
  companyCookie: string | null | undefined;
  legacyWorkspaceCookie: string | null | undefined;
}

/** Where the active company came from (for the one-time legacy migration). */
export type CompanySource = 'cookie' | 'legacy_cookie' | 'active_tenant' | 'only_company';

export type CompanyResolution =
  | { ok: true; companyId: string; source: CompanySource }
  | { ok: false; error: 'sites_not_enabled' | 'no_active_company' };

/** One company the editor can work in, for the chooser and the header. */
export interface CompanyChoice {
  id: string;
  name: string;
  slug: string;
  /** The company's workspace the editor acts in (see companyWorkspaceId). */
  workspaceId: string;
}

type SessionTenant = SessionVerifyResponse['tenants'][number];
type SessionWorkspace = SessionVerifyResponse['workspaces'][number];

function sessionTenants(session: SessionVerifyResponse): SessionTenant[] {
  return Array.isArray(session.tenants) ? session.tenants.filter(Boolean) : [];
}

function sessionWorkspaces(session: SessionVerifyResponse): SessionWorkspace[] {
  return Array.isArray(session.workspaces) ? session.workspaces.filter(Boolean) : [];
}

/**
 * The ids of the session's direct companies that hold the `sites` grant, in
 * session order. An entry without an `app_grants` field fails closed and is
 * logged once per call as version skew; an empty or other-only array is a
 * plain "not granted" (no log).
 */
export function sitesGrantedCompanyIds(
  session: SessionVerifyResponse,
  { logSkew = true }: { logSkew?: boolean } = {},
): string[] {
  let skew = false;
  const granted: string[] = [];
  for (const t of sessionTenants(session)) {
    const grants = (t as { app_grants?: unknown }).app_grants;
    if (grants === undefined) {
      skew = true;
      continue;
    }
    if (typeof t.id === 'string' && t.id && Array.isArray(grants) && grants.includes(SITES_APP)) {
      if (!granted.includes(t.id)) granted.push(t.id);
    }
  }
  if (skew && logSkew) console.error(`[app-grants] ${APP_GRANT_SKEW_MESSAGE} (session.tenants[])`);
  return granted;
}

/**
 * The workspace of the session the editor acts in for `companyId`, or null
 * when the session lists none for that company. Several workspaces: slug
 * `main`, else the oldest by `created_at`, ties by id (see the file header).
 */
export function companyWorkspaceId(
  session: SessionVerifyResponse,
  companyId: string,
): string | null {
  const own = sessionWorkspaces(session).filter(
    (w) => typeof w.id === 'string' && w.id && w.tenant_id === companyId,
  );
  if (own.length === 0) return null;
  if (own.length === 1) return own[0].id;
  const main = own.find((w) => w.slug === 'main');
  if (main) return main.id;
  const sorted = [...own].sort(
    (a, b) =>
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
      a.id.localeCompare(b.id),
  );
  return sorted[0].id;
}

/**
 * Every company of the session the editor can be used in (granted AND with a
 * workspace for this user), sorted by name for the chooser. Nothing here is
 * trusted for authorization: it only labels what the session already contains.
 */
export function listCompanyChoices(session: SessionVerifyResponse): CompanyChoice[] {
  const tenants = sessionTenants(session);
  const choices: CompanyChoice[] = [];
  for (const id of sitesGrantedCompanyIds(session)) {
    const workspaceId = companyWorkspaceId(session, id);
    if (!workspaceId) continue;
    const tenant = tenants.find((t) => t.id === id);
    choices.push({
      id,
      name: tenant?.name || tenant?.slug || id,
      slug: tenant?.slug ?? '',
      workspaceId,
    });
  }
  return choices.sort((a, b) => a.name.localeCompare(b.name, 'de') || a.id.localeCompare(b.id));
}

/**
 * The names of granted companies the user cannot open because the session has
 * no workspace of theirs in it (shown on the not-enabled page, never offered).
 */
export function grantedCompaniesWithoutWorkspace(session: SessionVerifyResponse): string[] {
  const tenants = sessionTenants(session);
  return sitesGrantedCompanyIds(session, { logSkew: false })
    .filter((id) => companyWorkspaceId(session, id) === null)
    .map((id) => {
      const t = tenants.find((x) => x.id === id);
      return t?.name || t?.slug || id;
    });
}

/**
 * Pick the company the editor acts in for this request. First match wins, and
 * every candidate must be USABLE (granted + a workspace in the session):
 *
 *   1. the `framer_company` cookie (a forged id, a company not in the session,
 *      or one without the grant is ignored: the cookie selects, never grants),
 *   2. the retired `framer_ws` cookie, mapped from its workspace to that
 *      workspace's company (the graceful migration from the per-workspace
 *      editor of PR #99),
 *   3. the session's `active_tenant`, the suite-wide default company,
 *   4. the only usable company.
 *
 * Otherwise no company: `sites_not_enabled` when no company of the session
 * holds the grant, else `no_active_company` (the dashboard then shows the
 * chooser, or the not-enabled page; it never bounces a valid session to the
 * login, which looped forever on 2026-10-19).
 */
export function resolveActiveCompany(
  session: SessionVerifyResponse,
  selectors: CompanySelectors,
): CompanyResolution {
  const usable = listCompanyChoices(session);
  const isUsable = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && usable.some((c) => c.id === id);

  if (isUsable(selectors.companyCookie)) {
    return { ok: true, companyId: selectors.companyCookie, source: 'cookie' };
  }

  const legacy = selectors.legacyWorkspaceCookie;
  if (typeof legacy === 'string' && legacy.length > 0) {
    const ws = sessionWorkspaces(session).find((w) => w.id === legacy);
    if (ws && isUsable(ws.tenant_id)) {
      return { ok: true, companyId: ws.tenant_id, source: 'legacy_cookie' };
    }
  }

  const active = session.active_tenant?.id;
  if (isUsable(active)) return { ok: true, companyId: active, source: 'active_tenant' };

  if (usable.length === 1) return { ok: true, companyId: usable[0].id, source: 'only_company' };

  return {
    ok: false,
    error:
      sitesGrantedCompanyIds(session, { logSkew: false }).length === 0
        ? 'sites_not_enabled'
        : 'no_active_company',
  };
}

/**
 * Resolve the tenant scope for a request from a verified session and an
 * explicit target workspace.
 *
 * We verify that workspace is one the session actually contains (membership is
 * enforced by auth-brain having returned it), then derive the tenant_group via
 * the workspace's tenant. A workspace not present in the session is a deny,
 * never a silent fallback to another workspace. This is the authorization
 * primitive; it does NOT check the `sites` grant (resolveActiveScope and
 * resolveScopeForCompanyWorkspace do).
 */
export function resolveScopeForWorkspace(
  session: SessionVerifyResponse,
  workspaceId: string,
): ScopeResult {
  const workspace = sessionWorkspaces(session).find((w) => w.id === workspaceId);
  if (!workspace) return { ok: false, error: 'workspace_not_in_session' };

  const tenant = sessionTenants(session).find((t) => t.id === workspace.tenant_id);
  if (!tenant) return { ok: false, error: 'tenant_not_in_session' };

  return {
    ok: true,
    scope: { workspaceId: workspace.id, tenantGroupId: tenant.group_id },
  };
}

/**
 * Resolve the scope for an explicitly named workspace, but only when it is the
 * editor workspace of a usable company (the `?workspace=` re-scope of the list
 * route). A workspace of a company without the grant is `sites_not_enabled`.
 */
export function resolveScopeForCompanyWorkspace(
  session: SessionVerifyResponse,
  workspaceId: string,
): ActiveScopeResult {
  const company = listCompanyChoices(session).find((c) => c.workspaceId === workspaceId);
  if (!company) {
    const inSession = sessionWorkspaces(session).some((w) => w.id === workspaceId);
    return { ok: false, error: inSession ? 'sites_not_enabled' : 'workspace_not_in_session' };
  }
  const result = resolveScopeForWorkspace(session, workspaceId);
  return result.ok ? { ok: true, scope: result.scope, companyId: company.id } : result;
}

/**
 * Resolve the tenant scope for the request's ACTIVE company (see
 * resolveActiveCompany for the order): that company's workspace, joined to its
 * tenant group. `selectors` is REQUIRED so no caller can silently skip the
 * app-local selection. Membership and the tenant join are still enforced by
 * resolveScopeForWorkspace.
 */
export function resolveActiveScope(
  session: SessionVerifyResponse,
  selectors: CompanySelectors,
): ActiveScopeResult {
  const company = resolveActiveCompany(session, selectors);
  if (!company.ok) return company;
  const workspaceId = companyWorkspaceId(session, company.companyId);
  // Unreachable: a resolved company is usable, so it has a workspace.
  if (!workspaceId) return { ok: false, error: 'no_active_company' };
  const result = resolveScopeForWorkspace(session, workspaceId);
  return result.ok ? { ok: true, scope: result.scope, companyId: company.companyId } : result;
}

/**
 * The 403 code and message a route answers for a scope that did not resolve.
 * `sites_not_enabled` keeps its own code; every other failure is
 * `no_active_company` (the caller has no company the editor can act in). The
 * routes keep their own JSON envelopes and only take the code and message.
 */
export function activeScopeDenial(error: ScopeResolutionError): {
  code: 'sites_not_enabled' | 'no_active_company';
  message: string;
} {
  if (error === 'sites_not_enabled') {
    return {
      code: 'sites_not_enabled',
      message: 'Lumitra Sites is not enabled for this company',
    };
  }
  return { code: 'no_active_company', message: 'no active company' };
}
