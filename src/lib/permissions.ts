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

import { definePermissions, PermissionDeniedError } from '@marlinjai/auth-brain-sdk';
import type { ResourceHandle } from '@marlinjai/auth-brain-sdk';
import { authBrainClient } from './auth-brain';
import { AuthzUnavailableError } from './authBrainAvailability';

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
  // The Books (invoicing). Checked on the active company's editor workspace,
  // AFTER the company's auth-brain app grant `books` (src/server/books/http).
  // Reading invoices discloses customers and revenue, so even the read needs a
  // workspace admin; a site viewer sees no books.
  viewBooks: {
    requires: 'workspace.admin',
    description: 'Read the company books: customers, documents, templates.',
  },
  editBooks: {
    requires: 'workspace.admin',
    description: 'Create customers, edit drafts, issue and cancel invoices, manage templates.',
  },
});

/** A framer-clone action name. */
export type FramerAction = keyof typeof FRAMER_PERMISSIONS;

/** Build the workspace resource handle the OpenFGA check evaluates against. */
function workspaceResource(workspaceId: string): ResourceHandle {
  return { type: 'workspace', id: workspaceId, workspaceId };
}

/**
 * Returns true iff `userId` may perform `action` in `workspaceId`, false for a
 * real deny (OpenFGA answered `allowed: false`).
 *
 * THROWS {@link AuthzUnavailableError} when OpenFGA could not answer at all:
 * the SDK's `can()` throws on a network error, any non-OK status (401 for a
 * missing or wrong pre-shared key, 5xx, an un-provisioned store) and a missing
 * OpenFGA configuration. That is never a grant, and never reported as a deny
 * either: routes wrapped in `withAuthAvailability` answer 503
 * `authz_unavailable`, the server-action guard throws `AuthError(503)`. The
 * cause is logged here, once, with the action and workspace but never the
 * cookie, the session or the token.
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
  } catch (err) {
    console.error(
      `[authz] OpenFGA check failed (action ${action}, workspace ${workspaceId}); answering authz_unavailable`,
      err,
    );
    throw new AuthzUnavailableError(err);
  }
}

/**
 * Throws {@link PermissionDeniedError} when `userId` may NOT perform `action` in
 * `workspaceId`. Use at a route boundary when the caller prefers an exception to
 * a boolean. Built on {@link can}, so an OpenFGA failure throws
 * {@link AuthzUnavailableError}, never a PermissionDeniedError.
 */
export async function requirePermission(
  userId: string,
  action: FramerAction,
  workspaceId: string,
): Promise<void> {
  if (!(await can(userId, action, workspaceId))) {
    throw new PermissionDeniedError(
      userId,
      FRAMER_PERMISSIONS[action].requires,
      workspaceResource(workspaceId),
    );
  }
}

export { PermissionDeniedError, AuthzUnavailableError };
