---
name: cms-migration-runner
track: cms
wave: 2
priority: P0
status: draft
depends_on: [cms-tenant-schema-bootstrap]
estimated_value: 8
estimated_cost: 6
owner: unassigned
---

# Per-tenant migration runner (DDL across N schemas)

## Goal

Build the runner that applies DDL changes across every per-tenant schema when the data-table adapter version bumps or a new system column is added. Without this, schema-per-tenant becomes a maintenance nightmare: a 1-line `ALTER TABLE` change has to be replayed against every customer's schema, with version tracking, with rollback story, with a low-traffic-window strategy. This is the operational counterweight to the schema-per-tenant default. Plan Revision G calls out "schema migrations across N tenant schemas during low-traffic windows" as a permanent ops cost; this spec ships the tooling that makes it tractable.

## Scope

**In:**
- Migration files at `cms-brain/migrations/tenant/0001_xxx.sql`, `0002_xxx.sql`, etc., one per DDL change
- Each migration declares: forward SQL, optional rollback SQL, applies-to-schemas-matching predicate (default: all)
- Migration metadata table in `cms_core` schema: `tenant_migrations` (tenant_id, migration_name, applied_at, success bool)
- Migration runner CLI: `pnpm cms migrate up [--tenant=<id>] [--dry-run]`. Walks the registry, applies each pending migration to each tenant schema with `SET LOCAL search_path`. Logs progress, batched with concurrency cap (default 4)
- Migration runner library used by the runtime to lazily-migrate a tenant on first request after a deploy (optional, behind feature flag): if `tenant_schemas.ddl_version < latest`, run pending migrations inside the request transaction. Useful for slow customers that didn't get hit during the rollout window
- Per-tenant lock to prevent two concurrent migration runs against the same schema (Postgres advisory lock keyed on tenant id)
- Failure handling: if migration N fails on tenant X, log, skip remaining tenants for that migration, halt for operator intervention. Subsequent migrations are NOT applied to tenant X until N succeeds
- Initial bootstrap migration (`0001_init`): the full data-table DDL set (`dt_tables`, `dt_columns`, `dt_rows`, `dt_relations`, `dt_files`, `dt_row_select_values`)

**Out (explicitly deferred):**
- Multi-region migration coordination (Phase 2 ops)
- Online schema-change tools (pt-online-schema-change, gh-ost). Postgres has fewer needs here than MySQL but big-table ALTERs may need them eventually
- Customer-facing schema evolution (rename, drop, type-change column on populated collection): that's a different problem (data-table handles via TEXT-everywhere). This spec is about CMS service infrastructure migrations, NOT customer-driven schema changes
- Backfill / data migration tooling (Phase 2 when first big migration hits)
- Migration UI / dashboard (Phase 2)
- Auto-rollback on partial failure (operator-driven for v1)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/migrations/tenant/0001_init.sql` | new | Full data-table DDL |
| `projects/lumitra-infra/cms-brain/migrations/tenant/README.md` | new | How to add a migration |
| `projects/lumitra-infra/cms-brain/packages/api/prisma/migrations/0002_tenant_migrations/` | new | `cms_core.tenant_migrations` table |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/migration-runner.ts` | new | Core runner |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/migration-loader.ts` | new | Loads migration files from disk |
| `projects/lumitra-infra/cms-brain/packages/api/src/cli/migrate.ts` | new | CLI entry: `pnpm cms migrate up` |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/lazy-migrate.ts` | new | Optional request-time lazy migration helper |

## API surface

```ts
// lib/migration-runner.ts
export type Migration = {
  name: string;              // '0002_add_owner_id_metadata'
  version: number;
  forward: string;           // SQL
  rollback?: string;         // SQL (optional)
  appliesTo?: (schemaName: string) => boolean;
};

export type MigrationResult = {
  tenantId: string;
  schemaName: string;
  migrationName: string;
  success: boolean;
  durationMs: number;
  error?: string;
};

export async function runMigrations(opts: {
  tenantIds?: string[];      // undefined = all tenants
  dryRun?: boolean;
  concurrency?: number;
  onProgress?: (r: MigrationResult) => void;
}): Promise<MigrationResult[]>;

// lib/lazy-migrate.ts
export async function ensureTenantMigrated(
  prisma: PrismaClient,
  tenantId: string,
): Promise<void>;
// Called from auth middleware (behind feature flag) before withTenantSearchPath.
// Acquires advisory lock, applies pending migrations, releases lock.
```

## Data shapes

```prisma
// cms_core.tenant_migrations
model TenantMigration {
  id             String   @id @default(uuid())
  tenantId       String   @map("tenant_id") @db.Uuid
  migrationName  String   @map("migration_name")
  version        Int
  appliedAt      DateTime @default(now()) @map("applied_at")
  success        Boolean
  durationMs     Int      @map("duration_ms")
  error          String?

  @@unique([tenantId, migrationName])
  @@index([tenantId])
  @@map("tenant_migrations")
  @@schema("cms_core")
}
```

## Test plan

- [ ] Unit: `migration-loader.test.ts` loads migrations in order, rejects malformed files
- [ ] Unit: `migration-runner.test.ts` applies a fake migration to one tenant, records success
- [ ] Unit: `migration-runner.test.ts` failure on tenant X stops the migration for X but completes other tenants
- [ ] Unit: `migration-runner.test.ts` re-running same migration is idempotent (skipped if already applied)
- [ ] Unit: advisory lock prevents concurrent runs against same tenant (two parallel runs serialize)
- [ ] Integration: provision 5 tenants, run `0001_init`, verify each tenant schema has the data-table tables
- [ ] Integration: add a fake `0002_add_test_column`, run `migrate up`, verify all 5 tenants get the column
- [ ] Integration: `lazy-migrate` on first request after deploy applies pending migrations inline
- [ ] Manual: in staging, add a no-op migration, run `pnpm cms migrate up --dry-run`, verify it lists the planned operations without applying

## Definition of done

- [ ] Code lands and typechecks
- [ ] CLI works: `pnpm cms migrate up` applies all pending, `--tenant=<id>` runs for one
- [ ] Concurrency cap respected (no thundering herd against Postgres)
- [ ] Advisory lock prevents double-application
- [ ] `tenant_migrations` table reflects every applied migration
- [ ] No regressions in tenant bootstrap (existing tenants still work)
- [ ] Documented in `cms-brain/migrations/tenant/README.md`
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **Migration file format:** plain SQL vs JS migrations (with rollback hooks)? Plain SQL is simpler. JS allows conditional logic ("only apply if column doesn't exist"). Recommended: plain SQL for v1, switch to JS only when a real migration needs conditional logic.
- **Concurrency cap default:** 4 simultaneous migrations against Postgres. Could be too aggressive for shared Hetzner instance. Recommended: default 4, configurable via env var, drop to 1 for the first big migration.
- **Lazy migration vs forced migration:** running migrations during a deploy window is operationally clean. Lazy migration on first request reduces deploy window pain but adds latency to the first hit. Recommended: forced migration as default, lazy migration behind feature flag for emergency fallback.
- **Migration rollback in production:** is rollback ever automatic, or only operator-driven? Recommended: never automatic. Rollback SQL exists for documentation and operator playbook only.
- **Schema evolution UX (open question carried from handover):** when a customer renames a column on a populated collection, that's data-table internal, not a CMS migration. Don't conflate. But surface this in the spec to make sure no one tries to use this runner for customer-driven schema changes.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Revision G)
- Spec dependency: `cms-tenant-schema-bootstrap`
- External: https://www.postgresql.org/docs/current/explicit-locking.html (advisory locks), https://www.prisma.io/docs/orm/prisma-migrate
