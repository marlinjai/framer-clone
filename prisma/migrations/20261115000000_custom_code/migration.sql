-- Sandboxed custom code, slice C1b (docs/plans/2026-11-02-sandboxed-custom-code.md, decisions D3, D4, D7, D18 and
-- "Decided in slice C1b"). Approved by Marlin by name on 2026-11-15.
--
-- ADDITIVE: one column on `sites` (default false, so every existing site stays off), four new empty tables, two
-- trigger functions with their triggers on those new tables, and the function `box_document`. No existing row, column,
-- constraint or privilege is changed. Nothing in the application reads or writes any of it until the guarded routes of
-- later slices exist, and nothing in the application imports the box (services/box). Rollback: rollback.sql beside
-- this file.
--
-- THE ORDER WITH prisma/sql/box-reader.sql. That file creates the role `box_reader` and is applied by the operator,
-- separately and at a time of its own (it needs Marlin's yes). `prisma migrate deploy` runs at EVERY container start,
-- and every fresh database (CI, local development, the other integration tests) runs this migration without that
-- file. (A dump restore runs no migration: it carries the result, the grant included; see deploy/README.md.) So this migration must not fail when the role does not exist: it always takes EXECUTE on
-- `box_document` from PUBLIC, and grants it to `box_reader` only if that role exists. box-reader.sql grants the same
-- if the function exists. Whichever runs first, the end state is the same: EXECUTE for the owner and `box_reader`,
-- nobody else (held by src/server/commerce/provisioning/__tests__/box-reader-roles.itest.ts, both orders). That holds
-- also when the two run AT THE SAME TIME: each side's check sees only what is committed, so both sides take the same
-- transaction-level advisory lock, key 7461001200 (box-reader.sql names the same key), as a statement of its own
-- before its check (here the first statement), and hold it until they commit. The later one waits for the earlier one's commit, and under READ
-- COMMITTED its check, a new statement, then sees the other side's object (the rehearsal holds both orders of that
-- too). The key is a fixed constant outside the int4 range, the range of every pg_catalog.hashtext key, so it equals
-- none of the repository's fixed keys (74610010 and 74610011 in the application, 74610020 in a test fixture, Prisma's
-- own 72707369, and the small keys of the tests, all in that range). Keys made with pg_catalog.hashtextextended span
-- all 64 bits; a collision with one of them is negligible (about 2^-64 per key).

-- The lock box-reader.sql takes too (key 7461001200, see "THE ORDER"), as a statement of its own and first, so this
-- migration waits for a box-reader.sql that holds it before it touches anything (no lock on `sites` held meanwhile),
-- and its check at the end runs after that file has committed. Inside a DO block, so it prints nothing.
DO $$ BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(7461001200); END $$;

-- AlterTable: off by default; switched only through the guarded route of a later slice.
ALTER TABLE "public"."sites" ADD COLUMN "custom_code_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: one piece of code of one site, named by the hash of its canonical manifest (D3).
CREATE TABLE "public"."custom_code_blobs" (
    "site_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "declaration" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked_at" TIMESTAMP(3),

    CONSTRAINT "custom_code_blobs_pkey" PRIMARY KEY ("site_id","sha256"),
    -- The box only ever asks for a lower case hex hash; anything else could never be served.
    CONSTRAINT "custom_code_blobs_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "custom_code_blobs_declaration_check" CHECK (jsonb_typeof("declaration") = 'object')
);

-- CreateTable: append-only record of what happened to a site's code (D3). No foreign key to the site on purpose.
CREATE TABLE "public"."custom_code_audit" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "sha256" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_code_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custom_code_audit_action_check" CHECK (
        "action" IN ('enable', 'disable', 'blob-write', 'blob-erase', 'blob-block', 'blob-unblock', 'proposal-accept')
    ),
    CONSTRAINT "custom_code_audit_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
);

-- CreateTable: code an importer or an agent proposes; never served, never rendered (D7).
CREATE TABLE "public"."custom_code_proposals" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "declaration" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_code_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custom_code_proposals_source_check" CHECK ("source" IN ('import', 'agent')),
    CONSTRAINT "custom_code_proposals_declaration_check" CHECK (jsonb_typeof("declaration") = 'object')
);

-- CreateTable: the takedown list (decision D32). A hash in it is never served, on any site, whatever happens to the
-- blob rows: no foreign key to any site, so neither deleting a site nor erasing a company removes an entry. Written by
-- the operator or the guarded route of a later slice, as the Prisma role; no grant to anyone.
CREATE TABLE "public"."custom_code_blocked_hashes" (
    "sha256" TEXT NOT NULL,
    "blocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "custom_code_blocked_hashes_pkey" PRIMARY KEY ("sha256"),
    CONSTRAINT "custom_code_blocked_hashes_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    -- An operator label, never a person's id: a company erasure keeps this list, so it must name no person. The label
    -- is `operator`, optionally with lower case words for the channel (`operator:abuse-report`); any value with a
    -- digit or of another shape is refused, so an id fits neither alone nor behind the label.
    CONSTRAINT "custom_code_blocked_hashes_blocked_by_check" CHECK ("blocked_by" ~ '^operator(:[a-z]+(-[a-z]+)*)?$' AND length("blocked_by") <= 64)
);

-- CreateIndex
CREATE INDEX "custom_code_audit_site_id_created_at_idx" ON "public"."custom_code_audit"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "custom_code_audit_workspace_id_idx" ON "public"."custom_code_audit"("workspace_id");

-- CreateIndex
CREATE INDEX "custom_code_audit_tenant_group_id_idx" ON "public"."custom_code_audit"("tenant_group_id");

-- CreateIndex
CREATE INDEX "custom_code_proposals_site_id_idx" ON "public"."custom_code_proposals"("site_id");

-- CreateIndex
CREATE INDEX "custom_code_proposals_workspace_id_idx" ON "public"."custom_code_proposals"("workspace_id");

-- CreateIndex
CREATE INDEX "custom_code_proposals_tenant_group_id_idx" ON "public"."custom_code_proposals"("tenant_group_id");

-- AddForeignKey: deleting a site deletes its code.
ALTER TABLE "public"."custom_code_blobs" ADD CONSTRAINT "custom_code_blobs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: composite, so the denormalised workspace can never disagree with the site's.
ALTER TABLE "public"."custom_code_proposals" ADD CONSTRAINT "custom_code_proposals_site_id_workspace_id_fkey" FOREIGN KEY ("site_id", "workspace_id") REFERENCES "public"."sites"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A blob is immutable (D4): its hash names exactly this code and declaration. Only the takedown column may change.
-- The application writes as the Prisma role, the bootstrap superuser, which no grant restrains; a trigger does.
CREATE FUNCTION "public"."custom_code_blobs_immutable"() RETURNS trigger AS $$
BEGIN
    IF (NEW."site_id", NEW."sha256", NEW."document", NEW."declaration", NEW."title", NEW."created_by", NEW."created_at")
       IS DISTINCT FROM
       (OLD."site_id", OLD."sha256", OLD."document", OLD."declaration", OLD."title", OLD."created_by", OLD."created_at") THEN
        RAISE EXCEPTION 'a custom code blob is immutable; only blocked_at may change (site %, hash %)', OLD."site_id", OLD."sha256"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "custom_code_blobs_immutable"
    BEFORE UPDATE ON "public"."custom_code_blobs"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."custom_code_blobs_immutable"();

-- The audit is append-only (D3): no row is ever changed. Deleting stays possible, because erasing a company's
-- personal data deletes its audit rows (src/server/erasure/public.ts, with the other audit tables).
CREATE FUNCTION "public"."custom_code_audit_append_only"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'custom_code_audit is append-only (row %)', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "custom_code_audit_append_only"
    BEFORE UPDATE ON "public"."custom_code_audit"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."custom_code_audit_append_only"();

-- What the box calls (D18), and the only thing its role `box_reader` may call. At most one row, for a pair the caller
-- already knows; a function and not a view, because a view could be listed (`SELECT *`) and would hand every site
-- id, hash, draft document and host name to whoever holds the role's password.
--   - SECURITY DEFINER with a fixed search_path that names pg_temp last (left out, the temporary schema is searched
--     first), every table schema-qualified, so the caller needs no right on any table.
--   - `live` is `custom_code_enabled AND blocked_at IS NULL` and the hash not in custom_code_blocked_hashes (D32). It
--     does not require the site to be published: the standalone preview runs drafts, and the hash is not guessable (D3).
--   - `document` is NULL unless `live`, so the role never gets the code of a blocked blob or of a site that switched
--     custom code off, and NULL when it is larger than a block may be (262144 bytes), so the box is not handed a row
--     it would refuse anyway.
--   - `subdomain_labels` leaves out every label kept for branch preview links (D13); the box drops them a second time.
--   - `custom_hostnames` holds live claims only (verified or active).
--   - Both lists are empty unless `live`: the box answers a pair that is not live without them, so it is not told a
--     site's host names for such a pair. A live pair whose document is too large keeps them (the box refuses it too).
CREATE FUNCTION "public"."box_document"(p_site_id text, p_sha256 text)
RETURNS TABLE (document text, live boolean, subdomain_labels text[], custom_hostnames text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    CASE WHEN q.live AND octet_length(q.document) <= 262144 THEN q.document END,
    q.live,
    CASE WHEN q.live THEN COALESCE(
      (SELECT array_agg(d.subdomain ORDER BY d.subdomain)
         FROM public.site_domains d
        WHERE d.site_id = q.site_id AND d.subdomain IS NOT NULL AND d.subdomain NOT LIKE 'preview-%'),
      ARRAY[]::text[]) ELSE ARRAY[]::text[] END,
    CASE WHEN q.live THEN COALESCE(
      (SELECT array_agg(d.custom_hostname ORDER BY d.custom_hostname)
         FROM public.site_domains d
        WHERE d.site_id = q.site_id AND d.custom_hostname IS NOT NULL AND d.verification_status IN ('verified', 'active')),
      ARRAY[]::text[]) ELSE ARRAY[]::text[] END
  FROM (
    SELECT b.site_id, b.document, (s.custom_code_enabled AND b.blocked_at IS NULL AND h.sha256 IS NULL) AS live
      FROM public.custom_code_blobs b
      JOIN public.sites s ON s.id = b.site_id
      LEFT JOIN public.custom_code_blocked_hashes h ON h.sha256 = b.sha256
     WHERE b.site_id = p_site_id AND b.sha256 = p_sha256
  ) q
$$;

-- Postgres gives EXECUTE on every new function to PUBLIC. This migration takes it from each of its own functions:
-- box_document is for box_reader alone, and a trigger function needs no EXECUTE to fire.
REVOKE ALL ON FUNCTION "public"."box_document"(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."custom_code_blobs_immutable"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."custom_code_audit_append_only"() FROM PUBLIC;

-- The grant to the box's role, only where the role exists (see "THE ORDER" above). Where it does not, box-reader.sql
-- gives it when it creates the role. The lock taken first thing (see "THE ORDER") is held until this migration commits.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'box_reader') THEN
        GRANT EXECUTE ON FUNCTION "public"."box_document"(text, text) TO box_reader;
    END IF;
END $$;
