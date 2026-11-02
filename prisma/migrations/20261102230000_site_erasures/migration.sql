-- Erasing personal data from a site's history (docs/plans/2026-11-01-immutable-published-copy.md,
-- "Erasing personal data from the history"). Additive: two columns with defaults and one table. Rewrites no row.

-- AlterTable
ALTER TABLE "public"."sites" ADD COLUMN     "erasure_epoch" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."site_revisions" ADD COLUMN     "rewritten_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."site_erasures" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "erased_by" TEXT NOT NULL,
    "erased_count" INTEGER NOT NULL,
    "remaining_count" INTEGER NOT NULL,
    "places" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_erasures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_erasures_site_id_idx" ON "public"."site_erasures"("site_id");

-- CreateIndex
CREATE INDEX "site_erasures_workspace_id_idx" ON "public"."site_erasures"("workspace_id");

-- CreateIndex
CREATE INDEX "site_erasures_tenant_group_id_idx" ON "public"."site_erasures"("tenant_group_id");
