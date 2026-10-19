// src/app/api/ai/cms-agent/undo/route.ts
//
// POST /api/ai/cms-agent/undo
//
// Reverses a content-agent run: it loads every AgentChange for the run, sorted
// by `position` DESC (reverse order of application), and replays each recorded
// inverse against the CMS adapter directly. Same trust boundary as the agent
// route: the REAL auth-brain path (getVerifiedSession -> resolveActiveScope ->
// authenticateRequest) once, then the run must belong to the active workspace
// (else 404) and every inverse is replayed through the workspace-scoped adapter
// (../scopedAdapter.ts).
//
// Undo is NOT a single transaction. Each inverse is applied independently; if
// one fails (e.g. a column was manually changed after the run), undo STOPS and
// returns a partial result with the failure surfaced in `warnings`, never
// silenced. Phase 2a's tool set (create + archive + update) is reversible, so a
// partial undo is an edge case, not the common path.
//
//   200 -> { undone, skipped, warnings }
//   400 -> bad JSON / missing runId
//   401 -> no session
//   403 -> no active company / Sites not enabled / not permitted to edit this workspace
//   404 -> no such run in the active workspace

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { z } from 'zod';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites';
import { getCmsAdapter } from '@/server/cms/adapterClient';
import { getPrismaClient } from '@/server/db';
import { applyInverse, type CmsAdapter } from '../executor';
import { workspaceScopedCmsAdapter } from '../scopedAdapter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ runId: z.string().min(1, 'runId is required') });

async function handlePOST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { error: { message: 'invalid JSON body', code: 'bad_json' } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: { message: 'invalid request body', code: 'bad_body', issues: parsed.error.issues } },
      { status: 400 },
    );
  }

  const session = await getVerifiedSession(request);
  if (!session) {
    return Response.json(
      { error: { message: 'authentication required', code: 'unauthorized' } },
      { status: 401 },
    );
  }
  const scopeResult = resolveActiveScope(session, readCompanySelectors(request));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return Response.json(
      { error: { message: denial.message, code: denial.code } },
      { status: 403 },
    );
  }
  const auth = await authenticateRequest(request, scopeResult.scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return Response.json(
      {
        error: {
          message: auth.error,
          code: auth.status === 401 ? 'unauthorized' : 'forbidden',
        },
      },
      { status: auth.status },
    );
  }

  const prisma = getPrismaClient();
  // The run must belong to the active workspace: a run id of another workspace
  // answers the same 404 as an unknown one, so a workspace-A editor can neither
  // replay workspace-B inverses nor learn that the run exists.
  const run = await prisma.agentRun.findUnique({
    where: { id: parsed.data.runId },
    select: { workspaceId: true },
  });
  if (!run || run.workspaceId !== scopeResult.scope.workspaceId) {
    return Response.json(
      { error: { message: 'run not found', code: 'not_found' } },
      { status: 404 },
    );
  }

  const changes = await prisma.agentChange.findMany({
    where: { runId: parsed.data.runId },
    orderBy: { position: 'desc' },
  });

  // Every inverse is replayed through the workspace-scoped adapter too, so even
  // a recorded payload can only touch entities of the active workspace.
  const adapter = workspaceScopedCmsAdapter(
    getCmsAdapter() as unknown as CmsAdapter,
    scopeResult.scope.workspaceId,
  );

  let undone = 0;
  const warnings: string[] = [];

  for (const change of changes) {
    try {
      await applyInverse(
        adapter,
        change.inverseTool,
        (change.inversePayload ?? {}) as Record<string, unknown>,
      );
      undone += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'inverse failed';
      warnings.push(`Could not reverse ${change.tool} (${change.inverseTool}): ${message}`);
      // Stop on first failure; the remaining changes count as skipped.
      break;
    }
  }

  const skipped = changes.length - undone;
  return Response.json({ undone, skipped, warnings });
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const POST = withAuthAvailability(handlePOST);
