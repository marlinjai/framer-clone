-- Rollback of 20261112200000_site_models. NOT run by `prisma migrate deploy` (Prisma reads migration.sql only); run by
-- hand, in a transaction, after `prisma migrate resolve --rolled-back 20261112200000_site_models`:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/migrations/20261112200000_site_models/rollback.sql
--
-- Drops only this migration's table (its indexes, constraints and foreign key go with it). Nothing else is touched.
-- It destroys the stored model METADATA: the blobs in object storage are not touched and would be orphans.
DROP TABLE IF EXISTS "public"."site_models";
