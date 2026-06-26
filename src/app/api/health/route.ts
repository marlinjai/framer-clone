// src/app/api/health/route.ts
//
// GET /api/health
//
// LIVENESS probe for the deploy-verify bracket (the reusable
// coolify-deploy-verify workflow curls this URL until 2xx before marking the
// GitHub Deployment success). It must answer 2xx whenever the container is
// serving, INDEPENDENT of the database: a DB outage is a readiness concern, not
// a "is the container up" concern, and a DB-coupled liveness check would roll a
// deploy back over a transient DB blip. The DB readiness probe lives separately
// at /api/health/db.
//
// nodejs runtime + force-dynamic so the probe is never statically cached and
// always reflects the live process.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json({ ok: true });
}
