-- prisma/sql/commerce-roles.sql
--
-- Postgres role topology for the owned commerce engine, on the
-- @marlinjai/tenant-db schema-per-tenant-group model (CM-02). This file
-- creates the TWO roles the commerce engine runs under and fixes their
-- PRIVILEGE topology + the search_path BACKSTOP. It is run ONCE, by an
-- operator / deploy step, as a superuser (or the database owner) OUTSIDE the
-- application's transaction pool. It is intentionally idempotent so it can be
-- re-applied safely.
--
-- It does NOT set passwords. The LOGIN passwords for each role are injected via
-- Infisical / Coolify at provisioning time with a separate
-- `ALTER ROLE ... WITH LOGIN PASSWORD`, never committed to the repository and
-- never written to a .env file. This file only fixes the privilege topology and
-- the ext-locked role-default search_path.
--
-- It does NOT create any tenant schema, table, or REVOKE. Under the tenant-db
-- model every `tg_<hex32>` schema and its per-schema USAGE / table / sequence
-- GRANTs to commerce_app, plus the append-only REVOKEs on the ledger / order
-- tables, are applied PER SCHEMA by the provisioning runner
-- (`provisionTenant`, which calls grantSchemaToAppRole + bootstrapAppRole)
-- inside the tenant migrations. This file only stands up the roles those grants
-- target. (Pre-MVP: this replaces the old single-`commerce`-schema role SQL;
-- there is no `commerce` schema or `IN SCHEMA commerce` default-privilege here
-- anymore — commerce is 100% per-tenant.)
--
-- =====================================================================
-- The two roles
-- =====================================================================
--
--   commerce_app  LOW-PRIVILEGE, DML-only. The role the pooled application
--                 connection authenticates as (COMMERCE_APP_DATABASE_URL, read
--                 by src/server/commerce/db.ts). It may SELECT / INSERT /
--                 UPDATE / DELETE within each provisioned `tg_<id>` schema (via
--                 the per-schema grants provisionTenant issues) but may NOT run
--                 DDL and owns NO object. Its DEFAULT search_path is locked to
--                 the single `ext` schema (the backstop below): every table
--                 must be schema-qualified or withSchema-qualified, so a bare
--                 unqualified table reference fails LOUDLY instead of silently
--                 reading a `public` decoy. It is the role the per-schema
--                 append-only REVOKEs (stock_movement, credit_note,
--                 credit_note_ref, "order", order_line_item) apply to, which is
--                 how those tables become append-only AT THE DATABASE for
--                 ordinary application traffic.
--
--   commerce_ddl  OWNER, DDL-capable (CREATE / ALTER / DROP). The role the
--                 migration / provisioning runner authenticates as
--                 (COMMERCE_OWNER_DATABASE_URL, read by the CM-11 provisioning
--                 code via createMigrationClient). It connects OUTSIDE the
--                 transaction pool (a direct connection) because schema changes
--                 must not interleave with pooled application transactions. Its
--                 search_path legitimately includes `public` for DDL, so it is
--                 NEVER used as the application base handle: assertBackstop()
--                 would (correctly) throw on it.

-- ---------------------------------------------------------------------
-- 1. Create the roles if they do not already exist.
-- ---------------------------------------------------------------------
-- NOLOGIN here: the LOGIN attribute and password are granted out-of-band via
-- Infisical so no secret lives in this file. Re-running is a no-op once the
-- roles exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
    CREATE ROLE commerce_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_ddl') THEN
    CREATE ROLE commerce_ddl NOLOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. The ext-locked search_path BACKSTOP on commerce_app (the crown).
-- ---------------------------------------------------------------------
-- This is the single most important line in the file. A ROLE DEFAULT
-- (ALTER ROLE ... SET), applied ONCE — NEVER a per-connection or per-request
-- `SET search_path` (postgres.js does not DISCARD on release, so a
-- connection-level SET would leak to the next pooled request). With
-- `search_path = ext`, ext-resident functions/extensions (ext.gen_uuid_v7,
-- pgcrypto, ext.touch_updated_at) resolve, but EVERY table (public OR tenant)
-- must be explicitly schema-qualified or withSchema-qualified. A bare
-- unqualified table reference therefore FAILS LOUDLY ("relation does not
-- exist") instead of silently reading a `public` decoy.
--
-- This mirrors @marlinjai/tenant-db's bootstrapAppRole (which provisionTenant
-- also invokes per provision); setting it here makes the role correct from
-- creation, so assertCommerceBackstop() passes even before any tenant exists.
-- Idempotent: ALTER ROLE ... SET is last-write-wins.
ALTER ROLE commerce_app SET search_path = ext;

-- commerce_ddl keeps Postgres's default search_path ("$user", public) — it is
-- the owner and legitimately needs `public` for DDL. We do NOT lock it to ext.
-- This is precisely why it must never be the application base handle:
-- assertBackstop() throws on any path containing `public`/`$user`.

-- ---------------------------------------------------------------------
-- 3. USAGE on the `ext` schema for commerce_app.
-- ---------------------------------------------------------------------
-- The ext schema (pgcrypto, gen_uuid_v7, touch_updated_at) is created by the
-- public migration set (`migratePublic`, CM-03). commerce_app needs USAGE on it
-- so the column DEFAULTs / triggers that resolve against `ext` work under its
-- ext-locked path. Guarded on schema existence so this file is order-independent
-- and idempotent: re-run after migratePublic to apply, harmless before.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ext') THEN
    GRANT USAGE ON SCHEMA ext TO commerce_app;
  END IF;
END
$$;

-- =====================================================================
-- Why the split into TWO roles gives the per-schema REVOKEs teeth
-- =====================================================================
--
-- The per-tenant migrations (CM-04) make the inventory ledger / order tables
-- append-only with, per `tg_<id>` schema, e.g.:
--
--     REVOKE UPDATE, DELETE ON tg_<id>.stock_movement FROM commerce_app;
--
-- That REVOKE only protects anything if BOTH hold:
--
-- 1. The application connects as a role that is NOT the table owner and is NOT
--    superuser. A table's owner (and any superuser) bypasses table
--    GRANT/REVOKE entirely. Because commerce_ddl OWNS the tg_<id> objects and
--    commerce_app is a distinct, non-owner, low-privilege DML role, the REVOKE
--    has teeth: the append-only guarantee is enforced by Postgres for ordinary
--    application traffic, not merely by application code.
--
-- 2. The app connection's role cannot be silently swapped for a more privileged
--    one. commerce_app and commerce_ddl are DISTINCT login roles with distinct
--    connection strings (COMMERCE_APP_DATABASE_URL vs COMMERCE_OWNER_DATABASE_URL),
--    so the pool for ordinary traffic (commerce_app) can never acquire DDL or
--    owner privileges. Migrations use a SEPARATE direct connection as
--    commerce_ddl, outside the transaction pool.
--
-- Pooling note: under the tenant-db model isolation is `withSchema` identifier
-- rewriting in the per-request handle (tenantDb), NOT a per-request `SET
-- search_path`. There is therefore no session search_path state to leak across
-- pooled clients; the only search_path is the immutable ext-locked role default
-- above. A transaction-pooling proxy needs no special server_reset_query for
-- search_path because the engine never issues a session-level SET.
