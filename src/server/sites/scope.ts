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
// framer-clone models no identity: the workspace -> tenant -> tenant_group
// hierarchy is owned by auth-brain and arrives on the SessionVerifyResponse.
// A site's workspace is the request's active workspace; the tenant_group is
// that workspace's tenant's group_id.

// Import the session type from the SDK (which re-exports it) rather than the
// transitive-only `@marlinjai/auth-brain-shared`, matching how permissions.ts
// imports its SDK types. Keeps the dependency surface to the single declared
// dep (`@marlinjai/auth-brain-sdk`).
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import type { TenantScope } from './repository';

/**
 * The reason a session could not be resolved to a scope, for a precise route
 * response (vs. a single opaque failure).
 */
export type ScopeResolutionError =
  | 'no_active_workspace'
  | 'workspace_not_in_session'
  | 'tenant_not_in_session';

export type ScopeResult =
  | { ok: true; scope: TenantScope }
  | { ok: false; error: ScopeResolutionError };

/**
 * Resolve the tenant scope for a request from a verified session and an
 * explicit target workspace.
 *
 * The caller passes the workspace the request acts in (e.g. from a route param
 * or the editor's current workspace). We verify that workspace is one the
 * session actually contains (membership is enforced by auth-brain having
 * returned it), then derive the tenant_group via the workspace's tenant. A
 * workspace not present in the session is a deny, never a silent fallback to
 * another workspace.
 */
export function resolveScopeForWorkspace(
  session: SessionVerifyResponse,
  workspaceId: string,
): ScopeResult {
  const workspace = session.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return { ok: false, error: 'workspace_not_in_session' };

  const tenant = session.tenants.find((t) => t.id === workspace.tenant_id);
  if (!tenant) return { ok: false, error: 'tenant_not_in_session' };

  return {
    ok: true,
    scope: { workspaceId: workspace.id, tenantGroupId: tenant.group_id },
  };
}

/**
 * Pick the workspace the editor acts in for this request, or null when none can
 * be chosen without asking the user. The order, first match wins:
 *
 *   1. the app-local `framer_ws` selector cookie, when the VERIFIED session
 *      contains that workspace (a forged or stale id is ignored, never trusted:
 *      the cookie is a selector, not a credential),
 *   2. the session's own `active_workspace`, when the session contains it,
 *   3. the only workspace, when the session has exactly one,
 *   4. otherwise null: the user has several workspaces and has not picked one.
 *      The dashboard then renders the workspace chooser; it never bounces to the
 *      login, because the session is valid (doing so looped forever between the
 *      editor and auth-brain, 2026-10-19).
 *
 * `active_tenant` is deliberately NOT used as a tiebreak: a company can own
 * several workspaces, and guessing one silently is the thing the chooser exists
 * to avoid.
 */
export function resolveActiveWorkspaceId(
  session: SessionVerifyResponse,
  cookieWorkspaceId: string | null | undefined,
): string | null {
  const workspaces = Array.isArray(session.workspaces) ? session.workspaces : [];
  const isMember = (id: string | null | undefined): id is string =>
    typeof id === 'string' && id.length > 0 && workspaces.some((w) => w.id === id);

  if (isMember(cookieWorkspaceId)) return cookieWorkspaceId;
  const active = session.active_workspace?.id;
  if (isMember(active)) return active;
  if (workspaces.length === 1) return workspaces[0].id;
  return null;
}

/**
 * Resolve the tenant scope for the request's ACTIVE workspace (see
 * resolveActiveWorkspaceId for the selection order). `cookieWorkspaceId` is the
 * raw `framer_ws` cookie value (null when absent); it is REQUIRED so no caller
 * can silently skip the app-local selection. Membership and the tenant join are
 * still enforced by resolveScopeForWorkspace.
 */
export function resolveActiveScope(
  session: SessionVerifyResponse,
  cookieWorkspaceId: string | null | undefined,
): ScopeResult {
  const workspaceId = resolveActiveWorkspaceId(session, cookieWorkspaceId);
  if (!workspaceId) return { ok: false, error: 'no_active_workspace' };
  return resolveScopeForWorkspace(session, workspaceId);
}

/** One workspace of the session, labelled for the chooser and the switcher. */
export interface WorkspaceChoice {
  id: string;
  name: string;
  slug: string;
  companyName: string;
  companySlug: string;
}

/**
 * Every workspace of the verified session, joined to its company (tenant) for
 * display, sorted by company then workspace name. Nothing here is trusted for
 * authorization: it only labels what the session already contains.
 */
export function listWorkspaceChoices(session: SessionVerifyResponse): WorkspaceChoice[] {
  const workspaces = Array.isArray(session.workspaces) ? session.workspaces : [];
  const tenants = Array.isArray(session.tenants) ? session.tenants : [];
  const seen = new Set<string>();
  const choices: WorkspaceChoice[] = [];
  for (const w of workspaces) {
    if (!w || typeof w.id !== 'string' || seen.has(w.id)) continue;
    seen.add(w.id);
    const tenant = tenants.find((t) => t.id === w.tenant_id);
    choices.push({
      id: w.id,
      name: w.name || w.slug || w.id,
      slug: w.slug ?? '',
      companyName: tenant?.name || tenant?.slug || '',
      companySlug: tenant?.slug ?? '',
    });
  }
  return choices.sort(
    (a, b) =>
      a.companyName.localeCompare(b.companyName, 'de') ||
      a.name.localeCompare(b.name, 'de'),
  );
}
