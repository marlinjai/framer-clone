-- Site settings for published sites (docs/plans/2026-10-23-published-site-essentials.md).
-- Additive: existing sites start with an empty object, which reads as all defaults.

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "site_settings" JSONB NOT NULL DEFAULT '{}';
