-- The immutable published copy (docs/plans/2026-11-01-immutable-published-copy.md).
-- Additive: one enum, one table, one nullable column. Rewrites no row and backfills nothing: a published
-- site with no revision keeps being served from site_pages until its first save or publish freezes it.

-- CreateEnum
CREATE TYPE "public"."SiteRevisionKind" AS ENUM ('publish', 'baseline');

-- AlterTable
ALTER TABLE "public"."sites" ADD COLUMN     "published_revision_id" TEXT;

-- CreateTable
CREATE TABLE "public"."site_revisions" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "public"."SiteRevisionKind" NOT NULL DEFAULT 'publish',
    "document" JSONB NOT NULL,
    "published_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sites_published_revision_id_idx" ON "public"."sites"("published_revision_id");

-- CreateIndex
CREATE INDEX "site_revisions_workspace_id_idx" ON "public"."site_revisions"("workspace_id");

-- CreateIndex
CREATE INDEX "site_revisions_tenant_group_id_idx" ON "public"."site_revisions"("tenant_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_revisions_site_id_number_key" ON "public"."site_revisions"("site_id", "number");

-- AddForeignKey
ALTER TABLE "public"."sites" ADD CONSTRAINT "sites_published_revision_id_fkey" FOREIGN KEY ("published_revision_id") REFERENCES "public"."site_revisions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."site_revisions" ADD CONSTRAINT "site_revisions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
