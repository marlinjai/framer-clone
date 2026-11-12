-- Site branches, slice S7 (docs/plans/2026-11-10-site-branches.md): "Undo this merge".
--
-- A merged branch's record says when its merge was undone, by whom, and which new branch now holds the
-- merged work. It also says why the copy kept for the undo went, when it went without an undo: its 30 days
-- ran out (`expired`), a later merge replaced it (`replaced`), or an erase of personal data could not clean
-- it fully and removed it (`erased`). Additive: four nullable columns, no row rewritten. Older code ignores
-- them, so a code rollback needs nothing.
ALTER TABLE "public"."site_branches"
    ADD COLUMN "undone_into_branch_id" TEXT,
    ADD COLUMN "undone_by" TEXT,
    ADD COLUMN "undone_at" TIMESTAMP(3),
    ADD COLUMN "main_before_ended" TEXT;
