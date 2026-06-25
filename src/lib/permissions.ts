/**
 * permissions.ts -- the framer-clone action vocabulary mapped onto auth-brain's
 * OpenFGA workspace roles.
 *
 * The auth-brain SDK's `can(userId, requirement, resource)` only understands a
 * fixed `"<scope>.<role>"` requirement, where scope is one of
 * `workspace | tenant | tenant_group` and role is a relation the OpenFGA model
 * actually defines (e.g. `workspace.admin | workspace.member | workspace.viewer`).
 * Anything else throws `Unknown scope`.
 *
 * So framer-clone's meaningful verbs (`editSite`, `viewSite`, `publishSite`,
 * `manageDomain`) are ACTION NAMES, each mapped through `definePermissions` to
 * the underlying `workspace.<role>` requirement OpenFGA enforces against the
 * membership tuples auth-brain syncs. The app owns a readable action
 * vocabulary; OpenFGA owns the relation graph. When physical per-resource
 * isolation later lands, only this map changes, not the call sites.
 *
 * `definePermissions` validates every `requires` at module load and throws on a
 * malformed requirement (a typo like `workspace.editor`), so a bad mapping
 * fails fast at boot rather than silently mis-authorizing at runtime.
 */

import {
  definePermissions,
  requirePermission as sdkRequirePermission,
  PermissionDeniedError,
} from '@marlinjai/auth-brain-sdk';
import type { ResourceHandle } from '@marlinjai/auth-brain-sdk';
import { authBrainClient } from './auth-brain';

/**
 * The framer-clone action vocabulary. Reads require workspace membership at the
 * `viewer` level; every mutation (edit, publish, custom-domain config) requires
 * `workspace.admin`. Tighten or relax an individual action here -- not at the
 * call sites -- as the role model evolves.
 */
export const FRAMER_PERMISSIONS = definePermissions({
  viewSite: {
    requires: 'workspace.viewer',
    description: 'Read a site, its pages, and its settings.',
  },
  editSite: {
    requires: 'workspace.admin',
    description: 'Mutate a site: pages, content, settings.',
  },
  publishSite: {
    requires: 'workspace.admin',
    description: 'Trigger the publish pipeline for a site.',
  },
  manageDomain: {
    requires: 'workspace.admin',
    description: 'Configure a custom domain or subdomain for a site.',
  },
});

/** A framer-clone action name. */
export type FramerAction = keyof typeof FRAMER_PERMISSIONS;

/** Build the workspace resource handle the OpenFGA check evaluates against. */
function workspaceResource(workspaceId: string): ResourceHandle {
  return { type: 'workspace', id: workspaceId, workspaceId };
}

/**
 * Returns true iff `userId` may perform `action` in `workspaceId`.
 *
 * Fail-closed contract: the underlying `can()` THROWS on any OpenFGA error
 * (network, 5xx, un-provisioned store, unknown scope) and returns false when
 * the relation is simply absent. This helper treats BOTH as a deny -- an
 * unreachable or un-provisioned OpenFGA never silently grants. We never log the
 * cookie, the session, or the OpenFGA response on any path.
 */
export async function can(
  userId: string,
  action: FramerAction,
  workspaceId: string,
): Promise<boolean> {
  try {
    return await authBrainClient.can(
      userId,
      FRAMER_PERMISSIONS[action].requires,
      workspaceResource(workspaceId),
    );
  } catch {
    return false;
  }
}

/**
 * Throws {@link PermissionDeniedError} when `userId` may NOT perform `action` in
 * `workspaceId`. Use at a route boundary when the caller prefers an exception to
 * a boolean. Unlike {@link can}, this lets an underlying OpenFGA error propagate
 * (still a non-success: the caller's catch must treat it as a deny).
 */
export async function requirePermission(
  userId: string,
  action: FramerAction,
  workspaceId: string,
): Promise<void> {
  await sdkRequirePermission(
    authBrainClient,
    userId,
    FRAMER_PERMISSIONS[action].requires,
    workspaceResource(workspaceId),
  );
}

export { PermissionDeniedError };
