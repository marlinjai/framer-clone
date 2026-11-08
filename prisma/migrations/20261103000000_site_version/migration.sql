-- The version lock (docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, build step 1): every
-- write of a site's working copy (save, publish, an erase of personal data) moves this number,
-- and a save or publish names the version it was based on, so an editor tab and an agent can
-- never silently overwrite each other. Additive: one column with a default. Rewrites no row.

-- AlterTable
ALTER TABLE "public"."sites" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
