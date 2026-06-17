---
name: track0-backend-foundation
track: cms-content-tier
wave: 1
priority: P0
status: done
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: []
touchesSharedState: true
sharedState: [prisma, lockfile, next-config, vitest-config]
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Backend foundation: Prisma + Postgres + server-only boundary + api conventions + test substrate

> NEW Track-0 prerequisite spec (re-scope 2026-06-16). HARD GATE before the CMS tier (Track A) and the commerce engine (Track B). framer-clone today has effectively NO backend: the only API route is `src/app/api/ai/edit/route.ts`, there is NO Prisma / `@prisma/client` / Postgres / `DATABASE_URL` anywhere in `src` (verified by grep), no `prisma/` dir, and all binding data is the client-side `InMemoryDataSourceProvider`. Both data engines need a real Postgres-backed Next.js server inside framer-clone plus a node-env + Dockerized-Postgres test substrate. This spec stands all of that up.

> SUPERSEDES the prior `docs/specs/build-2026-06/slice-0-backend-foundation/track0-backend-foundation.md`. Same goal, plus three critique fixes folded in: (1) the earlier adapter-prisma `workspace:*` registry defect is RESOLVED (republished at `0.2.2` with real semver deps), so the dep add is a clean `pnpm add` with no pre-flight gate; (2) the Prisma version is pinned concretely (`@prisma/client` is a normal dep of adapter-prisma, not a peer); (3) `server-only` is an explicit dep, and the test substrate (node-env vitest projects + Dockerized Postgres) is established here so the whole commerce track can satisfy its DoD.

## Goal

Turn framer-clone from a backendless Next.js app into one with a real Postgres-backed server. Add `@prisma/client` + `prisma`, create `prisma/schema.prisma` seeded with the adapter-prisma 8 `dt_*` models (commerce models are appended later by Track B onto the SAME file/datasource), stand up a server-only `PrismaClient` singleton at `src/server/db.ts` reading `DATABASE_URL` (Infisical/Coolify, never `.env`), establish the `src/server/**` boundary + the `src/app/api/*` route conventions, and establish the test substrate (node-env vitest + Dockerized Postgres) every downstream server spec depends on.

## Scope

**In:**
- **Dependency add:** `@prisma/client@^6.9.0` (runtime) + `prisma@^6.9.0` (dev) + `server-only` (runtime). Pin Prisma at the 6.x line that `@marlinjai/data-table-adapter-prisma@0.2.2` is generated against (its `package.json` declares `@prisma/client: ^6.9.0` as a normal DEPENDENCY, not a peer; one PrismaClient must serve both engines).
- `prisma/schema.prisma`: single file, single Postgres schema (NOT `multiSchema`). Seed with the adapter-prisma 8 `dt_*` models verbatim (`DtTable`, `DtColumn`, `SelectOption`, `DtRowSelectValue`, `DtRelation`, `DtFile`, `DtView`, `DtRow`), copied from `data-table/packages/adapter-prisma/prisma/schema.prisma`. `datasource db { provider = "postgresql"; url = env("DATABASE_URL") }`, `generator client { provider = "prisma-client-js" }`.
- `src/server/db.ts`: `import 'server-only'` first line; a `globalThis`-cached `getPrismaClient()` singleton (dev-HMR-safe, prevents connection storms).
- `src/server/README.md`: the `src/server/**` boundary contract (server-only, never imported by a client component; holds `db.ts` now, `cms/` + `commerce/` later) + the `src/app/api/*` route conventions (route segment, zod body validation, error envelope, `runtime = 'nodejs'`, the `can()`-shaped admin-guard seam for mutation routes / reads unauthenticated for v1).
- `src/lib/api/respond.ts`: `jsonError(code, message, status, extra?)` returning the `{ error: { code, message, ... } }` envelope the AI route already uses (`route.ts:94-110`), plus `parseBody(req, schema)` returning `{ok:true,data}` or `{ok:false,response}` (a 400 envelope).
- `src/app/api/health/db/route.ts`: `SELECT 1` liveness through the singleton, `{ ok: true }` / 503 envelope. `runtime = 'nodejs'`.
- **Test substrate:** migrate `vitest.config.ts` to the `projects` form (jsdom project for `src/**`, a node project for `src/server/**` + `src/lib/bindings/resolver/**`), with a regression check that the existing 16-test drag suite + bindings tests stay green. Add a Dockerized-Postgres integration harness: `testcontainers` (dev dep) OR a `docker-compose.test.yml` + a vitest `globalSetup` that boots Postgres and runs `prisma migrate deploy`, exposed as a separate `pnpm test:integration` script kept OUT of the headless `pnpm test` unit run.
- `package.json` scripts: `db:generate` (`prisma generate`), `db:migrate` (`prisma migrate dev`), `db:deploy` (`prisma migrate deploy`), `test:integration`. Document the migrate commands run under Infisical injection.

**Out (explicitly deferred):**
- Commerce models in `prisma/schema.prisma` (Track B `b2`/`b4`/`b5`/`b6` append them serially to this same file/datasource).
- The CMS adapterClient/repository (Track A `slice2-cms-server-adapter-and-repo`).
- `multiSchema` / schema-per-tenant (the `withTenant` chassis, deferred to E7).
- Coolify Postgres provisioning automation (Marlin runs the `scaffold-project` Postgres step; this spec documents the `DATABASE_URL` contract, does not provision infra from a Worker).
- Any auth (Track A `slice2-admin-guard-stub` owns the interim admin guard).

## adapter-prisma availability (RESOLVED, no longer a blocker)

The earlier `workspace:*` defect is RESOLVED. `@marlinjai/data-table-adapter-prisma@0.2.2` (and its transitive `@marlinjai/data-table-adapter-shared@0.2.2`) are published with real semver deps (`@marlinjai/data-table-core: ^0.3.0`, `@marlinjai/data-table-adapter-shared: ^0.2.2`), no `workspace:*` leak. `pnpm add @marlinjai/data-table-adapter-prisma@^0.2.2` installs cleanly. No republish, no pre-flight gate, no vendor fallback.

This Track-0 spec only needs `@prisma/client` + `prisma` + `server-only`. The adapter-prisma dep-add itself (`"@marlinjai/data-table-adapter-prisma": "^0.2.2"`, pulling adapter-shared transitively) is owned by `slice2-cms-server-adapter-and-repo`.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `package.json` | edit | add `@prisma/client@^6.9.0`, `prisma@^6.9.0`, `server-only`, `testcontainers` (dev); add `db:*` + `test:integration` scripts; `lockfile` shared-state |
| `prisma/schema.prisma` | new | datasource + generator + the 8 adapter-prisma `dt_*` models. `prisma` shared-state (OWNER of file creation) |
| `prisma/migrations/**` | new | initial migration creating the `dt_*` tables; committed |
| `src/server/db.ts` | new | `import 'server-only'`; `getPrismaClient()` HMR-safe singleton |
| `src/server/README.md` | new | server-only boundary contract + api conventions + admin-guard seam |
| `src/lib/api/respond.ts` | new | `jsonError`, `parseBody` matching the AI route envelope |
| `src/lib/api/__tests__/respond.test.ts` | new | envelope + body-parse unit tests (no DB) |
| `src/app/api/health/db/route.ts` | new | `SELECT 1` liveness; `runtime = 'nodejs'` |
| `src/app/api/health/db/__tests__/route.test.ts` | new | mocks the singleton; asserts ok / 503 envelope |
| `vitest.config.ts` | edit | migrate to `projects` form (jsdom for `src/**`, node for `src/server/**` + resolver). `vitest-config` shared-state |
| `vitest.integration.setup.ts` | new | Dockerized-Postgres globalSetup (boots PG, `prisma migrate deploy`) |
| `next.config.ts` | edit (if needed) | `serverExternalPackages` for `@prisma/client` under Next 15. `next-config` shared-state |

## API surface

```ts
// src/server/db.ts
import 'server-only';
export function getPrismaClient(): PrismaClient; // HMR-safe globalThis singleton

// src/lib/api/respond.ts
export function jsonError(code: string, message: string, status: number, extra?: Record<string, unknown>): Response;
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }>;

// route convention (every src/app/api/* handler):
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // for DB-backed routes
```

## Data shapes

```prisma
// prisma/schema.prisma (v1: single schema, single PrismaClient)
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

// The 8 adapter-prisma dt_* models, copied verbatim from
// data-table/packages/adapter-prisma/prisma/schema.prisma:
//   DtTable, DtColumn, SelectOption, DtRowSelectValue,
//   DtRelation, DtFile, DtView, DtRow
// (Track B appends the ~20 commerce models to THIS file/datasource later.)
```

## Test plan

- [ ] Unit (jsdom or node project): `respond.ts` `jsonError` produces `{ error: { code, message } }` with the right status; `parseBody` returns `{ok:true,data}` on a valid body, a 400 envelope `Response` on an invalid one.
- [ ] Unit (node project): the DB-health route, with `getPrismaClient` mocked, returns `{ ok: true }` on a resolving `SELECT 1`, a 503 envelope on a rejecting one (errors surface, never swallowed).
- [ ] Unit (node project): a smoke test asserts `getPrismaClient()` returns the same instance across two imports (single shared client).
- [ ] Integration (`pnpm test:integration`, Dockerized Postgres): `prisma migrate deploy` creates the 8 `dt_*` tables; a trivial `prisma.dtTable.findMany()` resolves.
- [ ] Regression: the existing 16-test drag suite + the wave-1 bindings tests stay green under the new `projects` vitest config (jsdom project unchanged for `src/**`).
- [ ] Build: `pnpm build` (`next build`) succeeds with NO build-time secret (a dummy/placeholder `DATABASE_URL` is enough; the singleton is lazy and `db:migrate`/integration tests are separate steps).

## Definition of done

- [ ] `@prisma/client@^6.9.0` + `prisma@^6.9.0` + `server-only` install cleanly. The adapter-prisma install (now a clean `^0.2.2` from npm) is the DoD of `slice2-cms-server-adapter-and-repo`, NOT this spec.
- [ ] `pnpm why @prisma/client` resolves to a SINGLE 6.x instance (no two divergent generated clients).
- [ ] `prisma/schema.prisma` holds the 8 `dt_*` models; initial migration committed; `pnpm exec prisma generate` succeeds and the client typechecks.
- [ ] `getPrismaClient()` is a server-only HMR-safe singleton; importing `src/server/db.ts` from a client component fails `next build` (the `import 'server-only'` guard, with `server-only` installed).
- [ ] `src/lib/api/respond.ts` envelope matches the AI route's error shape; unit tests pass.
- [ ] `GET /api/health/db` returns ok with a live DB, a 503 envelope when unreachable.
- [ ] `vitest.config.ts` is in `projects` form; the node project runs `src/server/**` + resolver tests; the existing jsdom suite is green; `pnpm test:integration` boots Postgres and runs migrations.
- [ ] `next build` succeeds with no build-time `DATABASE_URL` (verify is headless).
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.
- [ ] No MST involvement; InMemoryProvider still the active client provider until Track A swaps it.

## Open questions

- **adapter-prisma resolution (RESOLVED):** `@marlinjai/data-table-adapter-prisma@0.2.2` + `@marlinjai/data-table-adapter-shared@0.2.2` are published with real semver deps; framer-clone pins `^0.2.2` directly. No republish, no vendor fallback, no open decision.
- **Prisma schema layout (CONFIRM before merge):** single `prisma/schema.prisma` + single Postgres schema for v1 (RECOMMENDED, single-tenant); the `dt_*` (CMS) + commerce models live in the same file/datasource so one PrismaClient serves both; engine separation is the `src/server/cms` vs `src/server/commerce` code boundary, not a DB boundary. NOT `multiSchema` (that is the E7 chassis work).
- **Coolify Postgres + Infisical path:** Marlin provisions a dedicated single-schema Postgres via `scaffold-project` and sets `DATABASE_URL` in the framer-clone Infisical project. Confirm the project/path before the manual migrate step. The Worker does NOT provision infra.

## References

- Re-scope brief (2026-06-16): backend-foundation is a NEW hard prerequisite; framer-clone has zero Prisma/Postgres today.
- Critique (3 minors; the earlier adapter-prisma `workspace:*` blocker is RESOLVED via the `0.2.2` republish with real semver deps): Prisma is a normal dep not a peer; `server-only` must be explicit; vitest is single jsdom env and needs the `projects` migration; no Dockerized-PG harness exists yet.
- Code touchpoints: `src/app/api/ai/edit/route.ts:94-110` (error-envelope precedent), `data-table/packages/adapter-prisma/prisma/schema.prisma` (the 8 `dt_*` models), `data-table/packages/adapter-prisma/package.json` (`@prisma/client: ^6.9.0` dep), `.gitignore:48` (`.infisical.json` ignored), `vitest.config.ts` (single jsdom env to migrate)
- Standard: `~/.claude/CLAUDE.md` secrets section (`DATABASE_URL` via Infisical/Coolify, never `.env`)
- Orchestration: `docs/specs/build-2026-06/ORCHESTRATION-LOOP.md` section 7 (`prisma` shared-state -> `framer-clone/prisma/schema.prisma`, owned serially by THIS spec)
