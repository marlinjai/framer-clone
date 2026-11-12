-- Rollback of 20261112200000_site_models. NOT run by `prisma migrate deploy` (Prisma reads migration.sql only); run by
-- hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/migrations/20261112200000_site_models/rollback.sql
--
-- Do NOT run `prisma migrate resolve --rolled-back` for it: that works only for a migration that FAILED, and refuses
-- one that applied (P3012). This script forgets the migration itself, so a later deploy of the same commit applies it
-- again instead of treating it as done. It drops only this migration's table (its indexes, constraints and foreign key
-- go with it) and deletes only this migration's row of Prisma's history. Nothing else is touched. It destroys the
-- stored model METADATA: the blobs in object storage are not touched and would be orphans.
DROP TABLE IF EXISTS "public"."site_models";
DO $$
BEGIN
    IF to_regclass('_prisma_migrations') IS NOT NULL THEN
        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112200000_site_models';
    END IF;
END $$;
