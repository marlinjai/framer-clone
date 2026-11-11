-- Site branches, slice S7 (docs/plans/2026-11-10-site-branches.md): "Undo this merge".
--
-- A merged branch's record says when its merge was undone, by whom, and which new branch now holds the
-- merged work. Additive: three nullable columns, no row rewritten. Older code ignores them, so a code
-- rollback needs nothing.
ALTER TABLE "public"."site_branches"
    ADD COLUMN "undone_into_branch_id" TEXT,
    ADD COLUMN "undone_by" TEXT,
    ADD COLUMN "undone_at" TIMESTAMP(3);
