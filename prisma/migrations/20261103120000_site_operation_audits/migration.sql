-- The audit of the site operations library (docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, build
-- step 3): one row per write by an editor user or a company API key. Additive: one new table.

-- CreateTable
CREATE TABLE "public"."site_operation_audits" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_detail" JSONB,
    "operation" TEXT NOT NULL,
    "ops" JSONB,
    "version_before" INTEGER,
    "version_after" INTEGER,
    "revision" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_operation_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_operation_audits_site_id_created_at_idx" ON "public"."site_operation_audits"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "site_operation_audits_workspace_id_idx" ON "public"."site_operation_audits"("workspace_id");
