// src/app/api/ai/cms-agent/undo/route.ts
//
// POST /api/ai/cms-agent/undo
//
// Reverses a content-agent run: it loads every AgentChange for the run, sorted
// by `position` DESC (reverse order of application), and replays each recorded
// inverse against the CMS adapter directly. Same trust boundary as the agent
// route: the REAL auth-brain path (getVerifiedSession -> resolveActiveScope ->
// authenticateRequest) once, then getCmsAdapter() for dispatch.
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
//   403 -> no active workspace / not permitted to edit this workspace

import { z } from 'zod';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { resolveActiveScope } from '@/server/sites';
import { getCmsAdapter } from '@/server/cms/adapterClient';
import { getPrismaClient } from '@/server/db';
import { applyInverse, type CmsAdapter } from '../executor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ runId: z.string().min(1, 'runId is required') });

export async function POST(request: Request): Promise<Response> {
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
  const scopeResult = resolveActiveScope(session);
  if (!scopeResult.ok) {
    return Response.json(
      { error: { message: 'no active workspace', code: 'no_active_workspace' } },
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
  const changes = await prisma.agentChange.findMany({
    where: { runId: parsed.data.runId },
    orderBy: { position: 'desc' },
  });

  const adapter = getCmsAdapter() as unknown as CmsAdapter;

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
