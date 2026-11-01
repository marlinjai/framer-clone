import type { Migration } from '@marlinjai/tenant-db';

/**
 * The shop's durable work, `025_commerce_job` (docs/plans/2026-11-02-shop-backbone.md, sections 1.2 to 1.6). Purely
 * additive: one table and its three partial indexes.
 *
 * `commerce_job` is both the outbox and the timed job: a row is written in the transaction of the change that needs
 * it, a worker claims it under a lease, and a repeat of the work is harmless because every kind is idempotent.
 *
 *   - `run_at` is when the job is due and, while it runs, when its lease ends. So a crashed worker's job simply
 *     becomes due again, with no reaper and one index.
 *   - `attempts` counts claims since the last success, for backoff. `open_claims` counts claims that never finished:
 *     the crash count, which only the claim itself can act on, because a process that dies never reaches a failure
 *     path.
 *   - `cycle_started_at` is what give-up is measured from, so a recurring job created long ago does not die on its
 *     first transient failure.
 *   - `claim_token` fences a worker whose lease ran out: every finish is conditional on it.
 *   - `kind` has no CHECK on purpose. A kind is a registry entry, and the claim filters on the kinds the running
 *     build knows, so a rolled-back build leaves a newer build's jobs alone instead of killing them.
 *   - `payload` holds ids and cursors only (the size CHECK keeps it that way), `last_error` no personal data.
 *
 * Not append-only: commerce_app updates a job for its whole life and deletes old `done` rows.
 *
 * House style as 007 to 024: BARE names, ids TEXT minted by the application. Re-runnable.
 */
export const commerceJob: Migration = {
  id: '025_commerce_job',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "commerce_job" (
          "id"                TEXT         NOT NULL,
          "tenant_id"         TEXT         NOT NULL,
          "kind"              TEXT         NOT NULL,
          "dedupe_key"        TEXT         NOT NULL,
          "event_type"        TEXT,
          "payload"           JSONB        NOT NULL,
          "status"            TEXT         NOT NULL DEFAULT 'pending',
          "run_at"            TIMESTAMP(3) NOT NULL,
          "attempts"          INTEGER      NOT NULL DEFAULT 0,
          "open_claims"       INTEGER      NOT NULL DEFAULT 0,
          "cycle_started_at"  TIMESTAMP(3) NOT NULL,
          "claim_token"       TEXT,
          "last_error"        TEXT,
          "acknowledged_at"   TIMESTAMP(3),
          "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at"        TIMESTAMP(3) NOT NULL,
          "finished_at"       TIMESTAMP(3),
          CONSTRAINT "commerce_job_pkey" PRIMARY KEY ("tenant_id", "id"),
          CONSTRAINT "commerce_job_dedupe_key" UNIQUE ("tenant_id", "kind", "dedupe_key"),
          CONSTRAINT "commerce_job_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "commerce_job_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'dead')),
          CONSTRAINT "commerce_job_counters_check" CHECK ("attempts" >= 0 AND "open_claims" >= 0),
          CONSTRAINT "commerce_job_payload_check"
              CHECK (jsonb_typeof("payload") = 'object' AND length("payload"::text) <= 2000),
          CONSTRAINT "commerce_job_error_check" CHECK ("last_error" IS NULL OR length("last_error") <= 1000),
          CONSTRAINT "commerce_job_running_check" CHECK ("status" <> 'running' OR "claim_token" IS NOT NULL),
          CONSTRAINT "commerce_job_finished_check"
              CHECK ("status" NOT IN ('done', 'dead') OR "finished_at" IS NOT NULL)
      )
    `;
    await tx`CREATE INDEX IF NOT EXISTS "commerce_job_due_idx" ON "commerce_job" ("run_at") WHERE "status" IN ('pending', 'running')`;
    await tx`CREATE INDEX IF NOT EXISTS "commerce_job_dead_idx" ON "commerce_job" ("tenant_id", "created_at") WHERE "status" = 'dead'`;
    await tx`CREATE INDEX IF NOT EXISTS "commerce_job_done_idx" ON "commerce_job" ("finished_at") WHERE "status" = 'done'`;
  },
};
