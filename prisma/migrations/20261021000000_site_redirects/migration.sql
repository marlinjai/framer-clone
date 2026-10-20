-- Old-slug redirects for published sites (docs/plans/2026-10-21-page-settings-slug-redirects.md).
-- Additive: existing sites start with an empty list.

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "redirects" JSONB NOT NULL DEFAULT '[]';
