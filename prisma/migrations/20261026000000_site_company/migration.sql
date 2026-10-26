-- The company a site belongs to (docs/plans/2026-10-25-catalogue-design.md, slice 1).
-- Additive and nullable: stamped at creation and whenever a member of the company opens the site.

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "company_id" TEXT;
