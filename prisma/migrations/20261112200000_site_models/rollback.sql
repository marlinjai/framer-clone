-- Rollback of 20261112200000_site_models. NOT run by `prisma migrate deploy` (Prisma reads migration.sql only); run by
-- hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/migrations/20261112200000_site_models/rollback.sql
--
-- Leaving the empty table in place after a code rollback is the default and harmless; running this script is a
-- destructive step that needs its own explicit authorization. Do NOT run `prisma migrate resolve --rolled-back` for it:
-- that works only for a migration that FAILED, and refuses one that applied (P3012, checked on a scratch database). This script forgets the migration itself, so a later deploy of the same commit applies it
-- again instead of treating it as done. It drops only this migration's table (its indexes, constraints and foreign key
-- go with it) and deletes only this migration's row of Prisma's history. Nothing else is touched. It destroys the
-- stored model METADATA: the blobs in object storage are not touched and would be orphans.
--
-- It sets its own search path and names every object with its schema, like every file the operator applies as a
-- superuser: what it drops and deletes must not depend on the session's search path, which differs between databases,
-- rebuilds and sessions.
SET search_path = pg_catalog, pg_temp;
DROP TABLE IF EXISTS "public"."site_models";
DO $$
BEGIN
    IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL THEN
        DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '20261112200000_site_models';
    END IF;
END $$;
