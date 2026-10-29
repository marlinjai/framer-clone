// src/lib/ai/jobRoute.ts
//
// GET and DELETE handlers for a resumable AI run (./jobRegistry.ts), shared by
// /api/ai/generate-page/[id] and /api/ai/review-page/[id]:
//
//   GET    -> 200 { status: 'running', progress? } | { status: 'done', result }
//                | { status: 'failed', error } | { status: 'cancelled' }
//   DELETE -> 204, the run is stopped (or had already finished)
//   404    -> unknown, expired, or another user's or company's run (one answer
//             for all three, so a run id never confirms that a run exists)
//   401 / 403 / 503 -> the same auth boundary as the POST that started the run
//
// Auth is the POST's chain: getVerifiedSession -> resolveActiveScope ->
// authenticateRequest('editSite'), reading cookies off the Request.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites';
import { jsonError } from '@/lib/api/respond';
import type { JobRegistry } from './jobRegistry';

type RouteContext = { params: Promise<{ id: string }> };

async function owner(request: Request): Promise<{ userId: string; workspaceId: string } | Response> {
  const session = await getVerifiedSession(request);
  if (!session) return jsonError('unauthorized', 'authentication required', 401);
  const scopeResult = resolveActiveScope(session, readCompanySelectors(request));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
  }
  const auth = await authenticateRequest(request, scopeResult.scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return jsonError(auth.status === 401 ? 'unauthorized' : 'forbidden', auth.error, auth.status);
  }
  return { userId: auth.userId, workspaceId: scopeResult.scope.workspaceId };
}

const notFound = () => jsonError('not_found', 'this run is unknown or no longer available', 404);

export function jobRouteHandlers<P, R, E>(registry: () => JobRegistry<P, R, E>) {
  const GET = withAuthAvailability(async (request: Request, { params }: RouteContext): Promise<Response> => {
    const { id } = await params;
    const who = await owner(request);
    if (who instanceof Response) return who;
    const snapshot = registry().get(id, who);
    if (!snapshot) return notFound();
    return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } });
  });

  const DELETE = withAuthAvailability(async (request: Request, { params }: RouteContext): Promise<Response> => {
    const { id } = await params;
    const who = await owner(request);
    if (who instanceof Response) return who;
    if (!registry().cancel(id, who)) return notFound();
    return new Response(null, { status: 204 });
  });

  return { GET, DELETE };
}
