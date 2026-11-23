-- Rollback of 20261112300000_site_model_coordination. NOT run by `prisma migrate deploy` (Prisma reads migration.sql
-- only); run by hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -1 -f prisma/migrations/20261112300000_site_model_coordination/rollback.sql
--
-- Leaving the added columns and the empty table in place after a code rollback is the default and harmless; running this
-- script is a destructive step that needs its own explicit authorization. Do NOT run `prisma migrate resolve
-- --rolled-back` for it (refused for an applied migration, P3012). This script forgets the migration itself, so a later
-- deploy of the same commit applies it again. It drops only this migration's table and the columns it added to
-- site_models, and deletes only this migration's row of Prisma's history. PENDING rows are discarded with their column:
-- run it only when no upload or cleanup is in flight (the routes are disabled until their own gate).
--
-- It sets its own search path and names every object with its schema, like every file the operator applies as a
-- superuser: what it drops and deletes must not depend on the session's search path, which differs between databases,
-- rebuilds and sessions.
SET search_path = pg_catalog, pg_temp;
DROP TABLE IF EXISTS "public"."model_blob_tombstones";
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'site_models' AND column_name = 'state') THEN
        DELETE FROM "public"."site_models" WHERE "state" = 'pending';
    END IF;
END $$;
ALTER TABLE "public"."site_models" DROP CONSTRAINT IF EXISTS "site_models_state_check";
DROP INDEX IF EXISTS "public"."site_models_pending_until_idx";
ALTER TABLE "public"."site_models" DROP COLUMN IF EXISTS "attempt", DROP COLUMN IF EXISTS "pending_until", DROP COLUMN IF EXISTS "state";
DO $$
BEGIN
    IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL THEN
        DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '20261112300000_site_model_coordination';
    END IF;
END $$;
