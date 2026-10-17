-- prisma/sql/commerce-roles.sql
--
-- The two Postgres roles the commerce engine runs under, on the
-- @marlinjai/tenant-db schema-per-tenant-group model, with every privilege they
-- need on a fresh Postgres 16 database and nothing more.
--
-- WHO RUNS IT. Once per database, before the first container start, by a
-- superuser (on Coolify that is the database's own bootstrap user, e.g.
-- `framer_clone`), with `psql -v ON_ERROR_STOP=1`. It is idempotent: running it
-- again changes nothing and fails nothing, so it is safe to re-apply after an
-- upgrade of this file. It names no database: every database-level grant uses
-- current_database(), so the same file runs in tests and in production.
--
-- NO PASSWORDS. The roles are created NOLOGIN here. The deploy's role script
-- (infra repo, deployments/framer-clone/scripts/07-commerce-roles.sh) then runs
-- `ALTER ROLE <role> WITH LOGIN PASSWORD '...'` with freshly generated values and
-- writes the two connection strings into Infisical. Nothing secret is in this
-- file, and re-running it never takes the LOGIN attribute away again.
--
-- WHAT IT DOES NOT DO. It creates no tenant schema and no table. The `ext`
-- schema's contents and the `public.tenant_groups` registry come from the public
-- migrations (migratePublic), each `tg_<hex32>` schema plus its per-schema grants
-- and the append-only REVOKEs come from provisioning (provisionCommerceTenant).
-- Both run as commerce_ddl, at container start (deploy/boot.sh) and when a
-- company creates its first project.
--
-- REQUIRES POSTGRES 16 OR LATER. The ADMIN-only role grant below
-- (`WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`) and the narrowed CREATEROLE
-- semantics it relies on are Postgres 16 features; on older servers the file
-- stops with an error instead of granting something broader.
--
-- =====================================================================
-- The two roles
-- =====================================================================
--
--   commerce_app  LOW PRIVILEGE, DML only. The pooled application connection
--                 (COMMERCE_APP_DATABASE_URL, src/server/commerce/db.ts). It may
--                 SELECT / INSERT / UPDATE / DELETE inside each provisioned
--                 `tg_<id>` schema through the grants provisioning issues, minus
--                 UPDATE and DELETE on the append-only tables (stock_movement,
--                 credit_note, credit_note_ref, "order", order_line_item). It
--                 owns nothing, runs no DDL, and its default search_path is
--                 exactly `ext`, so an unqualified table name fails loudly
--                 instead of reading a `public` decoy (assertCommerceBackstop).
--
--   commerce_ddl  OWNER, not a superuser. The migration and provisioning
--                 connection (COMMERCE_OWNER_DATABASE_URL), used outside the
--                 request pool. It owns `ext`, the public commerce registry and
--                 every `tg_<id>` schema. Its search_path keeps `public`, which
--                 is why it is never the application handle.
--
-- The append-only guarantee rests on commerce_app being neither the owner of
-- the tables nor a superuser: an owner or superuser bypasses table privileges,
-- an ordinary grantee does not. commerce_ddl being a non-superuser is not
-- required for that guarantee, but it keeps a leaked owner URL from reaching
-- the rest of the server (other databases, roles, files).

-- ---------------------------------------------------------------------
-- 0. Refuse to run on a server older than Postgres 16.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'commerce-roles.sql needs Postgres 16 or later (found %)',
      current_setting('server_version');
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 1. Create the roles if they do not exist yet.
-- ---------------------------------------------------------------------
-- NOLOGIN on creation only: 07-commerce-roles.sh grants LOGIN with a password
-- afterwards, and a re-run of this file leaves that alone.
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

-- Pin the attributes on every run, so a role that pre-existed with broader
-- rights is brought back to the intended shape. CREATEROLE on commerce_ddl is
-- explained in section 4.
ALTER ROLE commerce_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE commerce_ddl NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS;

-- ---------------------------------------------------------------------
-- 2. Database level: both may connect, only the owner may create schemas.
-- ---------------------------------------------------------------------
-- CREATE ON DATABASE lets commerce_ddl create the `ext` and `tg_<id>` schemas
-- and install pgcrypto (a trusted extension since Postgres 13, so no superuser
-- is needed for it).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO commerce_app, commerce_ddl', current_database());
  EXECUTE format('GRANT CREATE ON DATABASE %I TO commerce_ddl', current_database());
END
$$;

-- ---------------------------------------------------------------------
-- 3. Schemas: `public` for the registry, `ext` owned by commerce_ddl.
-- ---------------------------------------------------------------------
-- Postgres 15 and later no longer let every role create objects in `public`.
-- The public migrations create public.__public_db_migrations,
-- public.tenant_groups and public.tenant_migration_progress there, owned by
-- commerce_ddl. commerce_app gets nothing on `public` beyond the default USAGE.
GRANT USAGE, CREATE ON SCHEMA public TO commerce_ddl;

-- `ext` holds pgcrypto, ext.gen_uuid_v7() and ext.touch_updated_at(), which the
-- tenant tables use as column defaults and triggers. Creating it here, owned by
-- commerce_ddl, makes the grant to commerce_app below independent of whether
-- the public migrations have run yet (their CREATE SCHEMA IF NOT EXISTS then
-- keeps this schema). Functions in it are executable by PUBLIC by default.
CREATE SCHEMA IF NOT EXISTS ext AUTHORIZATION commerce_ddl;
ALTER SCHEMA ext OWNER TO commerce_ddl;
GRANT USAGE ON SCHEMA ext TO commerce_app;

-- ---------------------------------------------------------------------
-- 4. The owner may set the app role's search_path, and nothing else on it.
-- ---------------------------------------------------------------------
-- Every provision runs tenant-db's bootstrapAppRole, which issues
-- `ALTER ROLE commerce_app SET search_path = ext`. On Postgres 16 a
-- non-superuser may change another role's settings only with CREATEROLE AND the
-- ADMIN option on that role. INHERIT FALSE and SET FALSE mean commerce_ddl does
-- not gain commerce_app's privileges and cannot become commerce_app; it may
-- only administer it. Postgres 16's CREATEROLE no longer reaches roles the
-- holder has no ADMIN option on, so commerce_ddl cannot touch `framer_clone` or
-- any other existing role. What CREATEROLE does still allow is creating new
-- roles (which start without any privilege on this database's objects).
GRANT commerce_app TO commerce_ddl WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;

-- ---------------------------------------------------------------------
-- 5. The ext-locked search_path backstop on commerce_app.
-- ---------------------------------------------------------------------
-- A role default, never a per-connection SET (postgres.js does not reset
-- session state when a pooled connection is reused). With search_path = ext the
-- ext functions resolve, but every table must be schema-qualified, so a bare
-- table name fails loudly. Provisioning sets the same value again; setting it
-- here makes the role correct before any tenant exists.
ALTER ROLE commerce_app SET search_path = ext;
-- commerce_ddl keeps the default ("$user", public): it needs `public` for DDL,
-- and assertBackstop() therefore refuses it as an application handle.
