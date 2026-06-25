// src/app/api/ai/cms-agent/undo/route.ts
//
// POST /api/ai/cms-agent/undo
//
// Reverses a content-agent run: it loads every AgentChange for the run, sorted
// by `position` DESC (reverse order of application), and replays each recorded
// inverse against the CMS adapter directly. Same trust boundary as the agent
// route: verifyAdminCookie(request) once, then getCmsAdapter() for dispatch.
//
// Undo is NOT a single transaction. Each inverse is applied independently; if
// one fails (e.g. a column was manually changed after the run), undo STOPS and
// returns a partial result with the failure surfaced in `warnings`, never
// silenced. Phase 2a's tool set (create + archive + update) is reversible, so a
// partial undo is an edge case, not the common path.
//
//   200 -> { undone, skipped, warnings }
//   400 -> bad JSON / missing runId
//   401 -> missing/invalid admin secret

import { z } from 'zod';
import { verifyAdminCookie } from '@/server/auth/adminAction';
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

  if (!verifyAdminCookie(request)) {
    return Response.json(
      { error: { message: 'admin secret required or invalid', code: 'unauthorized' } },
      { status: 401 },
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
