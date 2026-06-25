/**
 * auth-check.ts -- the per-resource authorization checks for framer-clone.
 *
 * These delegate every decision to auth-brain's OpenFGA via the action
 * vocabulary in `./permissions`. framer-clone owns no role/membership tables;
 * the tenant_group -> tenant -> workspace hierarchy is evaluated inside
 * auth-brain, so a single `can()` call covers the whole graph.
 *
 * P1a contract: the resource scope is the WORKSPACE id. The site -> workspace
 * lookup (reading `workspace_id` off a `sites` row, the way analytics reads it
 * off `projects`) lands with the site-persistence schema in P1b. Until then,
 * callers pass the workspace id directly, so this layer is already correct and
 * does not need a rewrite when the table arrives -- only a thin
 * `checkSiteAccess(userId, siteId)` wrapper that resolves the workspace first.
 */

import { can, type FramerAction } from './permissions';

/**
 * Returns true iff `userId` may perform `action` in `workspaceId`. Fail-closed:
 * any OpenFGA error or an absent relation is a deny (see `permissions.can`).
 */
export async function checkWorkspaceAccess(
  userId: string,
  workspaceId: string,
  action: FramerAction = 'viewSite',
): Promise<boolean> {
  if (!workspaceId) return false;
  return can(userId, action, workspaceId);
}
