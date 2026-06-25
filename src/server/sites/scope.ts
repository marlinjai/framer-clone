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
 * Resolve the tenant scope for the session's ACTIVE workspace (the
 * default-context path: no explicit workspace chosen). Falls back to a deny
 * when the session has no active workspace, rather than guessing one.
 */
export function resolveActiveScope(session: SessionVerifyResponse): ScopeResult {
  const active = session.active_workspace;
  if (!active) return { ok: false, error: 'no_active_workspace' };
  return resolveScopeForWorkspace(session, active.id);
}
