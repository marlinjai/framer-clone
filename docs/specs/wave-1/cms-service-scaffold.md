---
name: cms-service-scaffold
track: cms
wave: 1
priority: P0
status: draft
depends_on: []
estimated_value: 9
estimated_cost: 4
owner: unassigned
---

# CMS service scaffold (`cms.lumitra.co`)

## Goal

Stand up the bare HTTP service that becomes `cms.lumitra.co`: a Hono app deployable to Hetzner Coolify (Node.js runtime preferred over Cloudflare Workers because Prisma + Postgres + long migrations on Workers is awkward), wired to a hosted Postgres, with healthcheck, structured logging, and a CI deploy pipeline. Nothing user-facing yet. This is the foundation every other CMS spec depends on. Without it, no track can land collection CRUD, schema routing, or auth middleware.

## Scope

**In:**
- New repo or new package at `projects/lumitra-infra/cms-brain/` (working name, mirrors storage-brain layout: `packages/api`, `packages/sdk`, `packages/shared`)
- Hono HTTP server with `/health`, `/version` endpoints
- Postgres connection via `DATABASE_URL` (Hetzner-managed Postgres provisioned out-of-band)
- Prisma client wiring against the shared schema (the `dt_*` core tables from data-table go in the `public` schema or a `cms_core` schema, separate from per-tenant schemas)
- Dockerfile + Coolify deploy config
- Subdomain: `cms.lumitra.co` DNS pointing at Coolify
- Structured JSON logging (request id, workspace id placeholder, latency)
- Env-var loading via Infisical (`infisical run` wrapper for local dev)
- pnpm workspace registration so `@marlinjai/data-table-adapter-prisma` can be imported as a workspace dep

**Out (explicitly deferred):**
- Auth middleware (separate spec: `cms-auth-middleware-dual-principal`)
- Schema-per-tenant routing (separate spec: `cms-tenant-schema-bootstrap`)
- Any business endpoints (deferred to wave 2 specs)
- Multi-region or HA Postgres (Phase 2 ops concern)
- PgBouncer, slow-query attribution (deferred to `cms-ops-runbook-and-observability`)
- `app_users` table or end-user identity (Phase 2)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/` | new directory | New repo or sibling package to storage-brain |
| `projects/lumitra-infra/cms-brain/package.json` | new | pnpm workspace root |
| `projects/lumitra-infra/cms-brain/packages/api/package.json` | new | `@cms-brain/api` |
| `projects/lumitra-infra/cms-brain/packages/api/src/index.ts` | new | Hono app entry |
| `projects/lumitra-infra/cms-brain/packages/api/src/routes/health.ts` | new | `/health`, `/version` |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/prisma.ts` | new | Prisma client singleton, `DATABASE_URL` from env |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/logger.ts` | new | Structured JSON logger with request id |
| `projects/lumitra-infra/cms-brain/packages/api/Dockerfile` | new | Node 20 multi-stage build |
| `projects/lumitra-infra/cms-brain/.coolify.yaml` | new | Coolify deploy config |
| `projects/lumitra-infra/cms-brain/.gitignore` | new | Includes `.infisical.json` |

## API surface

```ts
// packages/api/src/index.ts
import { Hono } from 'hono';
import { healthRoutes } from './routes/health';

const app = new Hono();
app.route('/', healthRoutes);
export default app;

// packages/api/src/routes/health.ts
export const healthRoutes = new Hono()
  .get('/health', (c) => c.json({ ok: true, ts: Date.now() }))
  .get('/version', (c) => c.json({ version: process.env.GIT_SHA ?? 'dev' }));
```

## Data shapes

```ts
// No new persistent shapes in this spec.
// Reuses data-table's `dt_tables`, `dt_columns`, etc. (loaded by adapter-prisma)
// in the cms_core schema (public). Per-tenant schemas come in cms-tenant-schema-bootstrap.

// Env contract:
type Env = {
  DATABASE_URL: string;        // postgres connection string
  GIT_SHA?: string;            // injected at build time
  LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
};
```

## Test plan

- [ ] Unit: `routes/health.test.ts` returns 200 on `/health`, returns version string on `/version`
- [ ] Unit: `lib/prisma.ts` instantiates against a test DATABASE_URL, fails fast on missing env
- [ ] Integration: docker-compose with Postgres + the API, `curl /health` returns ok
- [ ] Manual: deploy to staging Coolify, confirm `https://cms-staging.lumitra.co/health` returns 200 (DNS may use a staging subdomain)

## Definition of done

- [ ] Service deploys to Coolify staging
- [ ] `/health` and `/version` reachable over HTTPS
- [ ] Prisma client connects on boot (logs success or fails fast)
- [ ] Structured logs visible in Coolify
- [ ] `.infisical.json` gitignored
- [ ] No regressions in storage-brain or other lumitra-infra packages
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **Runtime: Cloudflare Workers vs Hetzner Coolify Node.js?** Original plan suggested either. Prisma + Postgres + long-lived migrations push toward Coolify Node.js (recommended). Workers would force Prisma Accelerate and add latency. Decision: Coolify Node.js unless Marlin objects.
- **Repo location: standalone repo (`cms-brain`) or new package inside `lumitra-infra` monorepo?** Storage-brain precedent says monorepo. Recommended: monorepo as `projects/lumitra-infra/cms-brain/`.
- **Postgres: Hetzner-managed or self-hosted on a VM?** Operational tradeoff. Hetzner-managed is recommended for backup automation, but pricing needs confirmation.
- **Subdomain: `cms.lumitra.co` vs `data.lumitra.co` vs `db.lumitra.co`?** Working name in plan is `cms.lumitra.co`. Ratify or change.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Recommendation paragraph 1, Revision A)
- Memory: `memory/project_strategic_thesis_bubble_killer.md`
- Code touchpoints: `projects/lumitra-infra/storage-brain/packages/api/` (precedent layout)
- External: https://hono.dev, https://www.prisma.io/docs
