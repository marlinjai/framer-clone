import 'server-only';

// src/server/mcp/approvalCheck.ts
//
// Who may approve an agent's publish or rollback through the approval link
// (./approvals.ts), shared by the editor page that shows the request
// (src/app/projects/[projectId]/confirm/[approvalId]/page.tsx) and the route its
// button posts to (src/app/api/projects/[projectId]/confirmations/[approvalId]).
//
// The person is identified only by their verified editor session, never by
// anything the agent or the link carries. They must hold publishSite (the same
// check the editor's own Publish uses) on the workspace the request was opened
// for; the request's company and workspace come from the verified key that
// opened it, so a link can never approve a publish in another workspace. A
// request whose site changed since it was opened (another write, or the site
// removed) cannot be approved: the agent's next call would be refused anyway,
// and the person would be approving something they were not shown.

import { checkWorkspaceAccess } from '@/lib/auth-check';
import { getSiteRepository, SiteNotFoundError, type SiteRepository } from '@/server/sites';
import { getApprovalStore, type Approval, type ApprovalStore } from './approvals';

export interface ApprovalCheckDeps {
  store?: ApprovalStore;
  repository?: SiteRepository;
  canPublish?: (userId: string, workspaceId: string) => Promise<boolean>;
}

export type ApprovalCheck =
  /** Unknown, expired, already used, or not a request for this site. */
  | { status: 'not_found' }
  /** Signed in, but without publishSite on the request's workspace. */
  | { status: 'forbidden' }
  /** The site changed (or is gone) since the agent asked. */
  | { status: 'changed'; approval: Approval }
  | { status: 'ok'; approval: Approval };

/**
 * May `userId` approve request `approvalId` shown under `/projects/<projectId>`?
 * Throws AuthzUnavailableError when the permission check cannot be made (the
 * caller answers 503, never a "no").
 */
export async function checkApprover(
  userId: string,
  projectId: string,
  approvalId: string,
  deps: ApprovalCheckDeps = {},
): Promise<ApprovalCheck> {
  const approval = (deps.store ?? getApprovalStore()).get(approvalId);
  if (!approval || approval.siteId !== projectId) return { status: 'not_found' };
  const canPublish = deps.canPublish ?? ((user, workspace) => checkWorkspaceAccess(user, workspace, 'publishSite'));
  if (!(await canPublish(userId, approval.scope.workspaceId))) return { status: 'forbidden' };
  try {
    const { version } = await (deps.repository ?? getSiteRepository()).loadProjectWithVersion(approval.scope, approval.siteId);
    if (version !== approval.version) return { status: 'changed', approval };
  } catch (err) {
    if (err instanceof SiteNotFoundError) return { status: 'changed', approval };
    throw err;
  }
  return { status: 'ok', approval };
}

/** What the approval page and route show of a request: never the key or its company id. */
export function approvalView(approval: Approval) {
  return {
    id: approval.id,
    action: approval.action,
    siteId: approval.siteId,
    summary: approval.summary,
    version: approval.version,
    ...(approval.revision !== undefined ? { revision: approval.revision } : {}),
    expiresAt: new Date(approval.expiresAt).toISOString(),
    decision: approval.decision,
  };
}
