---
name: cms-ops-runbook-and-observability
track: cms
wave: 3
priority: P1
status: draft
depends_on: [cms-collection-crud-api, cms-row-crud-api, cms-migration-runner]
estimated_value: 7
estimated_cost: 6
owner: unassigned
---

# CMS ops runbook + observability hardening

## Goal

Translate plan Revision G's "permanent ops tax" warning into actual tooling and runbooks. Multi-tenant Postgres at any scale demands per-tenant slow-query attribution, connection pooling, resource governance (`statement_timeout`, query result-size limits), per-tenant restore tooling, GDPR right-to-be-forgotten, and an on-call runbook. This is not glamorous but it is what separates a service that survives 100 customers from one that quietly degrades. Wave 3 placement is intentional: this work is needed before Phase 1 takes its first real customer, NOT before the foundation specs land. Estimate: ~1 week initial setup, then ~10 to 20 percent of one engineer's time forever (per plan).

## Scope

**In:**
- PgBouncer (or pg-pool) deployment for the CMS service: transaction-mode pool, sized to workspace concurrency budget. Documented connection-mode limits (transaction mode interacts with `SET LOCAL search_path`, must be tested)
- Postgres `statement_timeout` set to 5s default per request, override per-route for known-long operations (migration, bulk operations)
- Per-tenant slow-query attribution: every Postgres log line includes `application_name = "cms-tenant-<id>"` (set per request via Prisma)
- Query result-size limits: row count cap (5000 default) on row list endpoints to prevent runaway queries
- Per-tenant restore script: `scripts/restore-tenant.sh <tenant-id> <backup-timestamp>` documented in `cms-brain/docs/runbook/restore.md`. Uses `pg_dump <schema>` + `pg_restore` against a scratch schema first, then surgical swap
- GDPR right-to-be-forgotten script: `scripts/forget-tenant.sh <tenant-id>` drops the tenant schema, removes `tenant_schemas` registry row, removes related storage-brain workspace files via SDK call. Documented in runbook
- Observability: Prometheus metrics endpoint (`/metrics`): request count, latency, per-tenant counts, slow-query count, pool saturation. Grafana dashboard JSON checked into repo
- Alerts: Postgres connection pool saturation (>80%), `statement_timeout` rate (>1%), tenant migration failure (>0)
- On-call runbook: `cms-brain/docs/runbook/oncall.md` covering the top 5 expected incidents (pool exhaustion, runaway query, migration stuck, customer reports missing data, slow-region latency spike)
- Per-tenant disk-usage tracking: cron job that records per-schema size in `cms_core.tenant_usage` table. Powers customer-facing storage quotas later

**Out (explicitly deferred):**
- Multi-region or HA Postgres failover (Phase 2 ops, when revenue justifies)
- Advanced rate-limiting (per-end-user, per-API-key) (Phase 2)
- Customer-facing usage dashboards (Phase 2)
- DSGVO-compliant cross-tenant audit log (Phase 2)
- Automated chaos testing (Phase 2)
- Automated per-tenant backup verification (Phase 2; v1 manual smoke-test once per quarter)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/deploy/pgbouncer.ini` | new | PgBouncer config |
| `projects/lumitra-infra/cms-brain/deploy/coolify-pgbouncer.yaml` | new | Coolify deploy |
| `projects/lumitra-infra/cms-brain/packages/api/src/middleware/statement-timeout.ts` | new | Per-request timeout middleware |
| `projects/lumitra-infra/cms-brain/packages/api/src/middleware/application-name.ts` | new | Tags Postgres connection with tenant id |
| `projects/lumitra-infra/cms-brain/packages/api/src/middleware/result-cap.ts` | new | Row count cap |
| `projects/lumitra-infra/cms-brain/packages/api/src/routes/metrics.ts` | new | `/metrics` endpoint |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/usage-cron.ts` | new | Disk-usage cron |
| `projects/lumitra-infra/cms-brain/scripts/restore-tenant.sh` | new | Per-tenant restore |
| `projects/lumitra-infra/cms-brain/scripts/forget-tenant.sh` | new | GDPR forget |
| `projects/lumitra-infra/cms-brain/docs/runbook/restore.md` | new | Restore runbook |
| `projects/lumitra-infra/cms-brain/docs/runbook/forget.md` | new | GDPR runbook |
| `projects/lumitra-infra/cms-brain/docs/runbook/oncall.md` | new | On-call runbook |
| `projects/lumitra-infra/cms-brain/deploy/grafana-dashboard.json` | new | Dashboard |
| `projects/lumitra-infra/cms-brain/packages/api/prisma/migrations/0003_tenant_usage/` | new | Usage table |

## API surface

```ts
// middleware/statement-timeout.ts
export function statementTimeout(ms: number): MiddlewareHandler;
// Wraps the request transaction with `SET LOCAL statement_timeout = <ms>`.

// middleware/application-name.ts
export const applicationName: MiddlewareHandler;
// Sets `application_name` on the connection per request: 'cms-tenant-<id>-<route>'.

// middleware/result-cap.ts
export function resultCap(max: number): MiddlewareHandler;
// Annotates request context with `c.var.maxRows = max`. Routes consult this.

// /metrics endpoint
// Standard Prometheus text format. Labels:
//   cms_request_total{tenant_id, route, status}
//   cms_request_duration_seconds_bucket{tenant_id, route, le}
//   cms_pg_pool_saturation
//   cms_statement_timeout_total{tenant_id, route}
//   cms_migration_failure_total{tenant_id, migration}
```

```sql
-- cms_core.tenant_usage
CREATE TABLE cms_core.tenant_usage (
  tenant_id     UUID NOT NULL,
  measured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_size_bytes  BIGINT NOT NULL,
  table_count   INT NOT NULL,
  row_count_estimate  BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, measured_at)
);
CREATE INDEX tenant_usage_tenant_idx ON cms_core.tenant_usage (tenant_id, measured_at DESC);
```

## Data shapes

```ts
// Usage cron output: writes one row per tenant per measurement window (default daily).
// Powers customer-facing storage quotas and ops capacity planning.

// Restore runbook flow (documented):
// 1. Confirm RTO target with customer (<1 hour for v1)
// 2. Spin up scratch Postgres schema `tenant_<id>_restore`
// 3. pg_restore <backup_file> --schema=tenant_<id> -d scratch_schema
// 4. Smoke-test: connect to CMS service against scratch schema, verify expected data
// 5. Coordination window: drop live schema, rename scratch to live
// 6. Update tenant_schemas.ddl_version if any migration delta
// 7. Smoke-test live, mark restore complete, notify customer

// Forget (GDPR) runbook flow:
// 1. Verify legal basis (signed deletion request)
// 2. Lock the tenant: set tenant_schemas.locked_at = now()
// 3. pg_dump <schema> --file=audit-archive-<tenant-id>-<date>.sql.enc (encrypted, 30-day retention for legal)
// 4. DROP SCHEMA tenant_<id> CASCADE
// 5. DELETE FROM cms_core.tenant_schemas WHERE tenant_id = ?
// 6. Call storage-brain SDK: deleteWorkspace(workspace_id) for each workspace under this tenant
// 7. Audit log entry, customer notification
```

## Test plan

- [ ] Unit: `statement-timeout.test.ts` long query is killed at the configured threshold, returns 408 / structured error
- [ ] Unit: `result-cap.test.ts` row list with limit > max gets capped, header signals truncation
- [ ] Unit: `application-name.test.ts` Postgres connection's `application_name` matches per-tenant pattern
- [ ] Integration: PgBouncer transaction mode + `SET LOCAL search_path` works correctly across multiple requests (no tenant-leak)
- [ ] Integration: restore script against a scratch tenant successfully recovers a backup
- [ ] Integration: forget script drops a scratch tenant cleanly, registry updated, storage-brain called
- [ ] Manual: load test 100 tenants x 10 requests/sec, verify pool saturation alert fires before exhaustion
- [ ] Manual: simulate a runaway query, verify it's killed at `statement_timeout`, alert fires
- [ ] Manual: restore runbook walked through end-to-end on staging

## Definition of done

- [ ] Code lands and typechecks
- [ ] PgBouncer deployed and validated against `SET LOCAL` semantics
- [ ] All three middleware layers active in production
- [ ] `/metrics` endpoint exposes the documented metrics
- [ ] Grafana dashboard imported, alerts configured
- [ ] Restore + forget scripts work end-to-end on staging
- [ ] Runbooks reviewed by Marlin
- [ ] Usage cron runs nightly, populates `tenant_usage`
- [ ] No regressions in throughput or latency (acceptable overhead: <5ms p50)
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **PgBouncer transaction mode + `SET LOCAL search_path`:** transaction-mode pooling rebinds connections per transaction. `SET LOCAL` is transaction-scoped, so this should be safe, BUT prepared statements get tricky. Need to verify with a load test. If broken, fallback: session-mode pool (more connections needed) or pg-pool with explicit affinity.
- **`statement_timeout` interaction with migrations:** the migration runner needs longer timeouts. Recommended: bypass the per-request timeout middleware for migration routes, set a higher per-migration timeout. Document.
- **GDPR retention period for the encrypted audit-archive:** 30 days is a guess. Legal counsel should confirm. Recommended: 30 days default, configurable, log every retrieval.
- **Per-tenant disk-usage measurement cost:** querying `pg_total_relation_size` for every schema nightly costs Postgres CPU. With 1000 tenants this is 1000 small queries. Recommended: batch via a single query against `pg_class` joining `pg_namespace`, store the snapshot.
- **Backup strategy:** assumed Hetzner-managed Postgres backups. Per-tenant restore requires `pg_dump --schema=` capability against the live DB OR the ability to restore the whole DB to scratch and extract one schema. Hetzner's product needs verification. If it doesn't expose `pg_dump --schema=`, we may need our own per-tenant nightly `pg_dump` cron.
- **Result-cap default of 5000 rows:** plan doesn't specify. 5000 is generous. Recommended: profile first 10 customers, tune. Some customers will hit it; need a graceful "use cursor pagination" message.
- **Real-time alerting channel:** Slack vs PagerDuty vs Discord. No preference yet. Recommended: PagerDuty for paying-customer-impact alerts, Slack for everything else.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Revision G, all bullets)
- Spec dependencies: `cms-collection-crud-api`, `cms-row-crud-api`, `cms-migration-runner`
- External: https://www.pgbouncer.org/config.html, https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-STATEMENT-TIMEOUT
