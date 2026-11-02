-- Reusable component definitions of a site (docs/plans/2026-11-02-reusable-components.md).
-- Additive: existing sites start with an empty object, which is no definitions. No row is rewritten.

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "components" JSONB NOT NULL DEFAULT '{}';
