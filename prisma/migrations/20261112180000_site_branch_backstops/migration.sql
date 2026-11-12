-- Site branches, the whole-feature review before S9 (docs/plans/2026-11-10-site-branches.md, decisions 87 and 91).
--
-- Two backstops for checks the application already makes, and one stored column that saves a read. Additive:
-- nothing is dropped, no row is rewritten by hand, and older code ignores all three, so a code rollback needs
-- nothing. `site_branches` holds no row anywhere before site branches are switched on for a company.

-- 1. A record's content row is a site of the record's own workspace. The first migration tied `branch_site_id`
--    to `sites(id)` alone, so only the application kept the two workspaces equal. This second key, beside the
--    first, makes any other workspace impossible in the database itself, as the record's main site already is.
--    `SET NULL (branch_site_id)` (Postgres 15 and later) clears the pointer only: `workspace_id` is required
--    and stays. Prisma cannot write a column list, so its schema keeps naming the first key and this one lives
--    here only.
ALTER TABLE "public"."site_branches" ADD CONSTRAINT "site_branches_branch_site_id_workspace_id_fkey"
    FOREIGN KEY ("branch_site_id", "workspace_id") REFERENCES "public"."sites"("id", "workspace_id")
    ON DELETE SET NULL ("branch_site_id") ON UPDATE CASCADE;

-- 2. A record's site is a main site, never a branch: a branch of a branch cannot be recorded, whatever code
--    writes the row. (`sites_branch_parent_guard` already keeps the content row from pointing at a branch.)
CREATE FUNCTION "public"."site_branches_site_is_main"() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "public"."sites" s WHERE s."id" = NEW."site_id" AND s."branch_of_site_id" IS NOT NULL) THEN
        RAISE EXCEPTION 'a site branch is recorded on its site, never on another branch (record %)', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "site_branches_site_is_main"
    BEFORE INSERT OR UPDATE OF "site_id" ON "public"."site_branches"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."site_branches_site_is_main"();

-- 3. The site's name at the fork point, kept beside the fork document by the database itself. "Was the site
--    renamed since this branch was made" is asked on every status read; reading it out of `base_document` there
--    unpacked the whole document (up to 10 MB) of every open branch each time. A generated column cannot drift
--    from the document, whoever writes it (a create, an update from main, an undo, an erase of personal data).
ALTER TABLE "public"."site_branches"
    ADD COLUMN "base_name" TEXT GENERATED ALWAYS AS ("base_document"->>'name') STORED;
