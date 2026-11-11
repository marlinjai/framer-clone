-- Site branches (docs/plans/2026-11-10-site-branches.md, section 4). Additive: one nullable column on `sites`,
-- constraints every existing row satisfies (each has branch_of_site_id NULL), one new table, no backfill, no row
-- rewritten. Older code ignores the column; the constraints and triggers below hold whatever code runs.

-- CreateEnum
CREATE TYPE "public"."SiteBranchStatus" AS ENUM ('open', 'ready', 'merged', 'discarded');

-- AlterTable
ALTER TABLE "public"."sites" ADD COLUMN     "branch_of_site_id" TEXT;

-- CreateTable
CREATE TABLE "public"."site_branches" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "company_id" TEXT,
    "branch_site_id" TEXT,
    "name" TEXT NOT NULL,
    "status" "public"."SiteBranchStatus" NOT NULL DEFAULT 'open',
    "base_version" INTEGER,
    "base_document" JSONB,
    "merge_draft" JSONB,
    "ready_by" TEXT,
    "ready_at" TIMESTAMP(3),
    "review_note" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_branch_version" INTEGER,
    "merged_by" TEXT,
    "merged_at" TIMESTAMP(3),
    "merged_from_version" INTEGER,
    "merged_main_version" INTEGER,
    "discarded_by" TEXT,
    "discarded_at" TIMESTAMP(3),
    "main_before_document" JSONB,
    "main_before_expires_at" TIMESTAMP(3),
    "created_by_kind" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_branches_branch_site_id_key" ON "public"."site_branches"("branch_site_id");

-- CreateIndex
CREATE INDEX "site_branches_site_id_idx" ON "public"."site_branches"("site_id");

-- CreateIndex
CREATE INDEX "site_branches_workspace_id_idx" ON "public"."site_branches"("workspace_id");

-- CreateIndex
CREATE INDEX "site_branches_tenant_group_id_idx" ON "public"."site_branches"("tenant_group_id");

-- CreateIndex
CREATE INDEX "sites_branch_of_site_id_idx" ON "public"."sites"("branch_of_site_id");

-- CreateIndex
CREATE UNIQUE INDEX "sites_id_workspace_id_key" ON "public"."sites"("id", "workspace_id");

-- AddForeignKey
ALTER TABLE "public"."sites" ADD CONSTRAINT "sites_branch_of_site_id_workspace_id_fkey" FOREIGN KEY ("branch_of_site_id", "workspace_id") REFERENCES "public"."sites"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."site_branches" ADD CONSTRAINT "site_branches_site_id_workspace_id_fkey" FOREIGN KEY ("site_id", "workspace_id") REFERENCES "public"."sites"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."site_branches" ADD CONSTRAINT "site_branches_branch_site_id_fkey" FOREIGN KEY ("branch_site_id") REFERENCES "public"."sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- What Prisma cannot express. Each is a backstop for a check the application makes first.
-- ---------------------------------------------------------------------------------------------------------------

-- A branch is never published and never carries a live revision: the public resolver requires `published`, so no
-- visitor can ever be served a branch, whatever code writes the row.
ALTER TABLE "public"."sites" ADD CONSTRAINT "sites_branch_never_published_check"
    CHECK ("branch_of_site_id" IS NULL OR ("status" = 'draft' AND "published_revision_id" IS NULL));

-- A site is not its own branch.
ALTER TABLE "public"."sites" ADD CONSTRAINT "sites_branch_not_self_check"
    CHECK ("branch_of_site_id" IS NULL OR "branch_of_site_id" <> "id");

-- No branch of a branch, and the parent pointer never changes after the row is created: set at INSERT only, so a
-- site that already has branches can never itself become one.
CREATE FUNCTION "public"."sites_branch_parent_guard"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."branch_of_site_id" IS DISTINCT FROM OLD."branch_of_site_id" THEN
        RAISE EXCEPTION 'sites.branch_of_site_id is set at creation and never changed (site %)', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' AND NEW."branch_of_site_id" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "public"."sites" p WHERE p."id" = NEW."branch_of_site_id" AND p."branch_of_site_id" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'a site branch cannot be made from another branch (site %)', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sites_branch_parent_guard"
    BEFORE INSERT OR UPDATE OF "branch_of_site_id" ON "public"."sites"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."sites_branch_parent_guard"();

-- A branch never holds an address: no platform subdomain, no custom domain.
CREATE FUNCTION "public"."site_domains_not_on_branch"() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "public"."sites" s WHERE s."id" = NEW."site_id" AND s."branch_of_site_id" IS NOT NULL) THEN
        RAISE EXCEPTION 'a site branch cannot hold a domain (site %)', NEW."site_id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "site_domains_not_on_branch"
    BEFORE INSERT OR UPDATE OF "site_id" ON "public"."site_domains"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."site_domains_not_on_branch"();

-- The record's id is the content row's id while that row exists; a closed branch holds no content row.
ALTER TABLE "public"."site_branches" ADD CONSTRAINT "site_branches_content_row_check"
    CHECK ("branch_site_id" IS NULL OR "branch_site_id" = "id");
ALTER TABLE "public"."site_branches" ADD CONSTRAINT "site_branches_closed_check"
    CHECK ("status" IN ('open', 'ready') OR "branch_site_id" IS NULL);
ALTER TABLE "public"."site_branches" ADD CONSTRAINT "site_branches_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 60);
ALTER TABLE "public"."site_branches" ADD CONSTRAINT "site_branches_created_by_kind_check"
    CHECK ("created_by_kind" IN ('user', 'key'));

-- A name is unique per site among open branches (compared without case); a closed branch's name is free again.
CREATE UNIQUE INDEX "site_branches_open_name_key"
    ON "public"."site_branches" ("site_id", lower("name"))
    WHERE "status" IN ('open', 'ready');

-- A record whose content row goes some other way than a merge or a discard (a code rollback that deletes the
-- branch as a site, a cascade): the foreign key sets branch_site_id NULL, and this closes the record as
-- discarded with its fork point and draft, so it frees its name and its place under the cap and keeps no copy.
CREATE FUNCTION "public"."site_branches_close_without_content"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_site_id IS NULL AND OLD.branch_site_id IS NOT NULL AND NEW.status IN ('open', 'ready') THEN
    NEW.status := 'discarded';
    NEW.discarded_at := COALESCE(NEW.discarded_at, now() AT TIME ZONE 'UTC');
    NEW.base_document := NULL;
    NEW.merge_draft := NULL;
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
    NEW.approved_branch_version := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "site_branches_close_without_content"
    BEFORE UPDATE OF "branch_site_id" ON "public"."site_branches"
    FOR EACH ROW EXECUTE FUNCTION "public"."site_branches_close_without_content"();
