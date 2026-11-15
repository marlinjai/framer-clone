-- Rollback of 20261115000000_custom_code. NOT run by `prisma migrate deploy` (Prisma reads migration.sql only); run by
-- hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/migrations/20261115000000_custom_code/rollback.sql
--
-- Run it only AFTER the application runs the previous image: this commit's Prisma client selects
-- sites.custom_code_enabled on every site query, so with this image still running every site read would fail, and its
-- next start would apply the migration again. Leaving the column, the tables and the functions in place after a code
-- rollback is the default and harmless: older code ignores them, and the box is deployed nowhere. Running this script is a destructive step that needs its own
-- explicit authorization: it destroys every stored custom code blob, proposal, audit row and takedown entry. Do NOT run `prisma migrate
-- resolve --rolled-back` for it (refused for an applied migration, P3012). This script forgets the migration itself, so
-- a later deploy of the same commit applies it again. It drops only what this migration created (the grant to
-- box_reader goes with the function) and deletes only this migration's row of Prisma's history. Safe to run twice.
DROP FUNCTION IF EXISTS "public"."box_document"(text, text);
DROP TABLE IF EXISTS "public"."custom_code_proposals";
DROP TABLE IF EXISTS "public"."custom_code_audit";
DROP TABLE IF EXISTS "public"."custom_code_blobs";
DROP TABLE IF EXISTS "public"."custom_code_blocked_hashes";
DROP FUNCTION IF EXISTS "public"."custom_code_audit_append_only"();
DROP FUNCTION IF EXISTS "public"."custom_code_blobs_immutable"();
ALTER TABLE "public"."sites" DROP COLUMN IF EXISTS "custom_code_enabled";
DO $$
BEGIN
    IF to_regclass('_prisma_migrations') IS NOT NULL THEN
        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261115000000_custom_code';
    END IF;
END $$;
