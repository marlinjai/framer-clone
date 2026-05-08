---
name: cms-tenant-schema-bootstrap
track: cms
wave: 1
priority: P0
status: draft
depends_on: [cms-service-scaffold]
estimated_value: 10
estimated_cost: 7
owner: unassigned
---

# Tenant schema-per-tenant bootstrap

## Goal

Build the schema-per-tenant routing layer that is non-negotiable per the plan's Revision B. Every authenticated request resolves the workspace's tenant id, then sets Postgres `search_path` to `tenant_<id>` before any data-table adapter call runs. This is the load-bearing isolation primitive for the CMS service. Retrofitting later is a multi-month migration project; building it Day 1 costs roughly 2 to 3 weeks but locks compliance, restore, and noisy-neighbour answers in from the start. This spec also ships the tenant provisioning hook (creates the schema when auth-brain emits a tenant-created outbox event) so new customers get a clean namespace automatically.

## Scope

**In:**
- Tenant resolution helper: `(workspaceId) -> tenantSchemaName` lookup against a `cms_core.tenant_schemas` registry table
- Postgres `search_path` injection in the request-scoped Prisma client (Prisma `$extends` or middleware)
- Schema creation on tenant provisioning: `CREATE SCHEMA tenant_<id>` + run all current data-table DDL inside it
- Tenant provisioning consumer: HTTP endpoint `POST /admin/tenants` (admin-key auth) that takes a tenant id and creates the schema. Outbox-event consumer wiring deferred to `cms-migration-runner` spec
- `tenant_schemas` registry table (in `cms_core` schema): `tenant_id`, `schema_name`, `created_at`, `version` (DDL version applied)
- `setSearchPath` helper that wraps a Prisma operation in a transaction with `SET LOCAL search_path TO tenant_<id>, public`
- Smoke test: provision two tenants, verify their `dt_tables` rows live in separate schemas, verify a query against tenant A cannot see tenant B's tables

**Out (explicitly deferred):**
- Migration runner across N schemas (separate spec: `cms-migration-runner`)
- Auth middleware that resolves workspace from session (separate spec: `cms-auth-middleware-dual-principal`)
- Per-tenant schemas for end-user `app_users` data (Phase 2; the schema registry already namespaces it correctly)
- Per-tenant Postgres roles / row-level grants (Phase 2 hardening)
- Cross-tenant queries (analytics, support tooling): out of scope for v1, never run from the request path

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/packages/api/prisma/schema.prisma` | new | `cms_core` schema with `TenantSchema` model |
| `projects/lumitra-infra/cms-brain/packages/api/prisma/migrations/0001_init/` | new | Initial migration creating `cms_core.tenant_schemas` |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/tenant-resolver.ts` | new | `resolveTenantSchema(workspaceId)`, with cache |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/prisma-tenant.ts` | new | `withTenantSearchPath(prisma, schemaName, fn)` |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/provisioning.ts` | new | `provisionTenantSchema(tenantId)`: CREATE SCHEMA + run DDL |
| `projects/lumitra-infra/cms-brain/packages/api/src/routes/admin-tenants.ts` | new | `POST /admin/tenants`, admin-key auth |

## API surface

```ts
// lib/tenant-resolver.ts
export type TenantSchemaInfo = {
  tenantId: string;
  schemaName: string;       // e.g. "tenant_a3f9b2c1"
  ddlVersion: number;
};

export async function resolveTenantSchema(
  workspaceId: string,
): Promise<TenantSchemaInfo>;

// lib/prisma-tenant.ts
export async function withTenantSearchPath<T>(
  prisma: PrismaClient,
  schemaName: string,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T>;
// Implementation: prisma.$transaction(async (tx) => {
//   await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schemaName}", public`);
//   return fn(tx);
// })
// schemaName MUST be validated against the registry to avoid SQL injection.

// lib/provisioning.ts
export async function provisionTenantSchema(
  tenantId: string,
): Promise<TenantSchemaInfo>;

// routes/admin-tenants.ts
// POST /admin/tenants  body: { tenantId: string }  auth: X-Admin-Key
// 201 { tenantId, schemaName, ddlVersion }
```

## Data shapes

```prisma
// cms_core schema
model TenantSchema {
  tenantId   String   @id @map("tenant_id") @db.Uuid
  schemaName String   @unique @map("schema_name")
  ddlVersion Int      @default(0) @map("ddl_version")
  createdAt  DateTime @default(now()) @map("created_at")

  @@map("tenant_schemas")
  @@schema("cms_core")
}
```

```sql
-- Per-tenant schema layout (created by provisioning):
CREATE SCHEMA "tenant_a3f9b2c1";
SET search_path TO "tenant_a3f9b2c1";
-- Then run all data-table DDL:
--   dt_tables, dt_columns, dt_rows, dt_relations, dt_files, dt_row_select_values, ...
-- (sourced from @marlinjai/data-table-adapter-prisma's migration files)
```

## Test plan

- [ ] Unit: `tenant-resolver.test.ts` resolves a known workspace id, throws on unknown
- [ ] Unit: `prisma-tenant.test.ts` confirms `SET LOCAL search_path` is scoped to the transaction (a follow-up query outside the wrapper does NOT see tenant tables)
- [ ] Unit: schema name validation rejects `tenant_; DROP SCHEMA public --` and similar payloads
- [ ] Integration: `provisioning.test.ts` provisions two tenants, inserts a `dt_tables` row in each, verifies isolation (tenant A query returns only tenant A's row)
- [ ] Integration: `admin-tenants.test.ts` POST returns 201 with admin key, 401 without
- [ ] Manual: in staging, provision a tenant, run `\dn` in psql to confirm schema exists, run `\dt tenant_<id>.*` to confirm DDL applied

## Definition of done

- [ ] Code lands and typechecks
- [ ] Tests pass (`pnpm test`)
- [ ] Two tenants can be provisioned and are isolated
- [ ] Schema-name SQL injection is blocked by registry validation
- [ ] No regressions in `cms-service-scaffold` healthcheck
- [ ] Docs in `cms-brain/README.md` updated with provisioning flow
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **Schema name format:** `tenant_<uuid-no-dashes>` vs `tenant_<short-id>`. UUID-no-dashes is 32 chars and Postgres identifier limit is 63, fine. Recommended: UUID-no-dashes for collision safety.
- **DDL source of truth:** Should the per-tenant DDL be a checked-in `.sql` file inside `cms-brain` or imported from `@marlinjai/data-table-adapter-prisma`? Option B avoids drift but needs adapter-prisma to expose its migrations as a consumable artifact. Recommended: copy the DDL into `cms-brain/prisma/tenant-template.sql` Day 1, document the sync process, revisit when adapter-prisma stabilizes.
- **Connection pool sizing under N tenant schemas:** PgBouncer or pg-pool? Deferred to ops spec but flag now: per-request `SET LOCAL search_path` interacts with transaction-pooled connections. Recommended: session-pooled connections OR PgBouncer in transaction mode with the `SET LOCAL` (which is transaction-scoped). Verify before scale.
- **Outbox consumer location:** Does this service consume auth-brain's outbox directly (HTTP poll), subscribe via webhook, or share a queue? Auth-brain v1 spec section 5 has not landed yet. Recommended: build the `POST /admin/tenants` endpoint now, wire the consumer in a follow-up spec when auth-brain ships its outbox surface.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Revision B, F.1)
- Code touchpoints: `projects/data-table/packages/adapter-prisma/prisma/schema.prisma`, `projects/data-table/packages/adapter-prisma/src/ddl.ts`
- External: https://www.postgresql.org/docs/current/ddl-schemas.html, https://www.prisma.io/docs/orm/prisma-client/queries/raw-database-access#using-set-local
