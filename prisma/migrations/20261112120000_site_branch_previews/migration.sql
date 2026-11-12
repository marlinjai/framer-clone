-- Site branches, slice S8 (docs/plans/2026-11-10-site-branches.md, section 7): the public preview link.
--
-- One row per branch that has a link: the address `preview-<token>.<sites base host>` shows the branch's working
-- copy, read only, to anyone who holds it. Only a SHA-256 of the token is stored, so the table cannot be used to
-- open a preview. A branch has at most one link; a new one replaces it, revoking deletes it, and closing the branch
-- (merge, discard) or deleting it takes the row with it.
--
-- Additive: one table and one unique index on `site_branches` that every existing row satisfies (`id` is already
-- its primary key). Older code ignores both, so a code rollback needs nothing.

-- CreateTable
CREATE TABLE "public"."site_branch_previews" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "company_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_branch_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_branch_previews_branch_id_key" ON "public"."site_branch_previews"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_branch_previews_token_hash_key" ON "public"."site_branch_previews"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "site_branch_previews_branch_id_workspace_id_key" ON "public"."site_branch_previews"("branch_id", "workspace_id");

-- CreateIndex
CREATE INDEX "site_branch_previews_workspace_id_idx" ON "public"."site_branch_previews"("workspace_id");

-- CreateIndex
CREATE INDEX "site_branch_previews_tenant_group_id_idx" ON "public"."site_branch_previews"("tenant_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_branches_id_workspace_id_key" ON "public"."site_branches"("id", "workspace_id");

-- AddForeignKey: composite, as `site_branches` is tied to its site, so a link of another workspace's branch cannot exist.
ALTER TABLE "public"."site_branch_previews" ADD CONSTRAINT "site_branch_previews_branch_id_workspace_id_fkey" FOREIGN KEY ("branch_id", "workspace_id") REFERENCES "public"."site_branches"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A stored hash is a SHA-256 in lowercase hex and nothing else: a token itself can never be stored by mistake.
ALTER TABLE "public"."site_branch_previews" ADD CONSTRAINT "site_branch_previews_token_hash_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
