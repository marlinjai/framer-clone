-- prisma/sql/commerce-roles.sql
--
-- Postgres role topology for the owned commerce engine. This file creates the
-- TWO roles the commerce engine runs under. It is run once, by an
-- administrator / provisioning step, OUTSIDE the application's transaction
-- pool (see the commerce_ddl note below). It is intentionally idempotent so it
-- can be re-applied safely.
--
-- It does NOT set passwords. Credentials (the LOGIN passwords for each role)
-- are injected via Infisical / Coolify at provisioning time with a separate
-- `ALTER ROLE ... WITH PASSWORD`, never committed to the repository and never
-- written to a .env file. This file only fixes the PRIVILEGE topology.
--
-- It does NOT create any table, REVOKE anything, or reference any domain
-- object. The actual `REVOKE UPDATE, DELETE ON stock_movement FROM
-- commerce_app` lands in b2 once the ledger table exists. The rationale for
-- why that REVOKE only means anything once these two roles exist is documented
-- at the bottom of this file.
--
-- =====================================================================
-- The two roles
-- =====================================================================
--
--   commerce_app  DML-only. The role the pooled application connection
--                 authenticates as (through PgBouncer). It may SELECT /
--                 INSERT / UPDATE / DELETE within the commerce schema but may
--                 NOT run DDL. It is the role the future
--                 `REVOKE UPDATE, DELETE ON stock_movement` applies to, which
--                 is how the inventory ledger becomes append-only AT THE
--                 DATABASE for ordinary application traffic.
--
--   commerce_ddl  DDL-capable (CREATE / ALTER / DROP within the schema).
--                 The role migrations and provisioning authenticate as. It
--                 connects OUTSIDE the transaction pool (a direct connection,
--                 not through the PgBouncer transaction pool) because schema
--                 changes must not be interleaved with pooled application
--                 transactions. Migrations / this script run as commerce_ddl.

-- Create the roles if they do not already exist. NOLOGIN here: the LOGIN
-- attribute and password are granted out-of-band via Infisical so no secret
-- lives in this file. Re-running is a no-op once the roles exist.
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

-- The commerce schema itself is created by the migration runner (as
-- commerce_ddl) in a later spec. These grants describe the steady-state
-- privilege split and are written so they can be re-applied after the schema
-- exists. For single-tenant v1 the schema name is the constant 'commerce'
-- (mirrors COMMERCE_SCHEMA in src/server/commerce/withTenant.ts).

-- commerce_ddl owns and may change the schema (CREATE / ALTER / DROP objects).
GRANT USAGE, CREATE ON SCHEMA commerce TO commerce_ddl;

-- commerce_app may use the schema and run DML, but never DDL. It does not get
-- CREATE on the schema, so it cannot add or alter tables.
GRANT USAGE ON SCHEMA commerce TO commerce_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA commerce TO commerce_app;

-- Objects commerce_ddl creates later must grant DML to commerce_app by default,
-- otherwise every new table would need a manual GRANT. (b2's REVOKE then
-- selectively narrows this default on the ledger table.)
ALTER DEFAULT PRIVILEGES FOR ROLE commerce_ddl IN SCHEMA commerce
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO commerce_app;

-- =====================================================================
-- Why the b2 REVOKE is only meaningful under TWO roles + a PgBouncer note
-- =====================================================================
--
-- b2 makes the inventory ledger append-only with:
--
--     REVOKE UPDATE, DELETE ON commerce.stock_movement FROM commerce_app;
--
-- That REVOKE only protects anything if BOTH of the following hold:
--
-- 1. The application connects as a role that is NOT the table owner and does
--    NOT have superuser. A table's owner (and any superuser) bypasses table
--    GRANT/REVOKE entirely, so if the app connected as commerce_ddl (the
--    owner) or as a superuser, the REVOKE would be cosmetic: the app could
--    still UPDATE/DELETE ledger rows. Splitting into commerce_app (DML, non
--    owner) and commerce_ddl (owner, used only by migrations out of band) is
--    what gives the REVOKE teeth. The append-only guarantee is enforced by
--    Postgres for ordinary application traffic, not merely by application code.
--
-- 2. The app connection's role cannot be silently swapped for a more
--    privileged one mid-pool. This is the PgBouncer concern below.
--
-- PgBouncer `server_reset_query` requirement:
--
--   The commerce engine relies on `SET LOCAL search_path` inside each
--   transaction (see withTenant.ts). SET LOCAL is transaction-scoped, so it is
--   automatically discarded at COMMIT/ROLLBACK and is the correct primitive
--   under a TRANSACTION-pooling PgBouncer. For any session-level state that
--   might be set, PgBouncer MUST be configured with a `server_reset_query`
--   (e.g. `DISCARD ALL`) so a backend connection is scrubbed before it is
--   handed to the next client. Two consequences:
--
--     - Do NOT rely on session-scoped `SET search_path`; it would leak across
--       pooled clients. Always use the transaction-scoped SET LOCAL in
--       withTenant. (server_reset_query backstops session state but the engine
--       must not depend on per-session settings in the first place.)
--     - commerce_app and commerce_ddl must be DISTINCT database login roles so
--       the pool for ordinary traffic (commerce_app) can never acquire DDL or
--       owner privileges. Migrations use a SEPARATE direct connection as
--       commerce_ddl, outside the transaction pool.
