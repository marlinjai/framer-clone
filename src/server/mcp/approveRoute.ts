import 'server-only';

// src/server/mcp/approveRoute.ts
//
// POST /api/projects/<projectId>/confirmations/<approvalId> with
// { decision: 'approve' | 'decline' }: a signed-in person decides on the publish
// or rollback an agent asked for (./approvals.ts). An editor
// route like the rest of /api/projects: the middleware refuses it on a published
// host (404), without a session cookie (401) and from another origin (403), and
// strips the cookie of a bearer request, so an agent's key can never approve. The
// route still checks everything itself: the verified session, publishSite on the
// request's workspace, and that the site has not changed since the agent asked.

import { getVerifiedSession } from '@/lib/auth-api';
import { jsonError } from '@/lib/api/respond';
import { getApprovalStore, type ApprovalDecision } from './approvals';
import { approvalView, checkApprover, freshSignInUrl, signedInRecently, type ApprovalCheckDeps } from './approvalCheck';

/** A write a page on another origin caused (defense in depth behind the middleware's check). */
function crossSite(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin';
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() !== (req.headers.get('host') ?? '').toLowerCase();
  } catch {
    return true;
  }
}

export async function approveConfirmation(
  req: Request,
  projectId: string,
  approvalId: string,
  deps: ApprovalCheckDeps = {},
): Promise<Response> {
  if (crossSite(req)) return jsonError('cross_origin_refused', 'cross-origin request refused', 403);
  const session = await getVerifiedSession(req);
  const userId = session?.user?.id;
  if (!userId) return jsonError('unauthorized', 'authentication required', 401);
  if (!signedInRecently(session, (deps.now ?? Date.now)())) {
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host;
    const page = `${proto}://${host}/projects/${encodeURIComponent(projectId)}/confirm/${encodeURIComponent(approvalId)}`;
    return jsonError('reauth_required', 'to approve, sign in again: your sign-in is older than 15 minutes', 403, { reauthUrl: freshSignInUrl(page) });
  }

  let decision: ApprovalDecision;
  try {
    const body = (await req.json()) as { decision?: unknown };
    if (body?.decision !== 'approve' && body?.decision !== 'decline') throw new Error('bad decision');
    decision = body.decision;
  } catch {
    return jsonError('invalid_request', 'send { "decision": "approve" } or { "decision": "decline" }', 400);
  }

  const checked = await checkApprover(userId, projectId, approvalId, deps);
  if (checked.status === 'not_found') {
    return jsonError('approval_not_found', 'this approval link is unknown, expired or already used; ask the agent for a new one', 404);
  }
  if (checked.status === 'forbidden') {
    return jsonError('forbidden', 'you may not publish this site, so you cannot approve this', 403);
  }
  // A changed site can still be declined; only approving it is refused.
  if (checked.status === 'changed' && decision === 'approve') {
    return jsonError('site_changed', 'the site changed since the agent asked; nothing was approved. Ask the agent to read the site again and send a new link', 409);
  }

  const outcome = (deps.store ?? getApprovalStore()).decide(approvalId, userId, decision);
  if (outcome.kind === 'not_found') {
    return jsonError('approval_not_found', 'this approval link expired or was used meanwhile; ask the agent for a new one', 404);
  }
  if (outcome.kind === 'already_decided') {
    return jsonError('already_decided', `this request was already ${outcome.approval.decision === 'approve' ? 'approved' : 'declined'}; the first decision stands`, 409);
  }
  console.info(
    '[mcp-approval]',
    JSON.stringify({
      at: new Date().toISOString(),
      approvalId,
      action: outcome.approval.action,
      siteId: outcome.approval.siteId,
      version: outcome.approval.version,
      keyId: outcome.approval.keyId,
      workspaceId: outcome.approval.scope.workspaceId,
      decidedBy: userId,
      decision,
    }),
  );
  return Response.json({ approval: approvalView(outcome.approval) }, { status: 200, headers: { 'cache-control': 'no-store' } });
}
