-- The ledger of company erasures auth-brain delivers (docs/plans/2026-11-05-company-erasure-consumer.md):
-- one row per event id, so a repeated delivery of a finished erasure answers 2xx without deleting again.
-- Additive: one new table, nothing existing changes.

-- CreateTable
CREATE TABLE "public"."erasure_events" (
    "event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "erasure_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "erasure_events_tenant_id_idx" ON "public"."erasure_events"("tenant_id");
