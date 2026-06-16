// src/app/api/health/db/route.ts
//
// GET /api/health/db
//
// Liveness probe for the Postgres connection. Runs `SELECT 1` through the
// server-only PrismaClient singleton. Returns `{ ok: true }` when the DB
// answers, or a 503 `{ error: { code, message } }` envelope when it does not.
// Errors surface in the envelope; they are never swallowed into a fake ok.
//
// nodejs runtime (PrismaClient needs Node, not the edge runtime);
// force-dynamic so the probe is never statically cached.

import { getPrismaClient } from '@/server/db';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'database unreachable';
    return jsonError('db_unreachable', message, 503);
  }
}
