-- prisma/sql/box-reader.sql
--
-- STATE: PREPARED AND REHEARSED OFFLINE ONLY. Not applied to any real
-- database. Applying it to production is a privilege change that needs
-- Marlin's yes by name (docs/plans/2026-11-02-sandboxed-custom-code.md,
-- decisions D20 and D24). Nothing in this repository applies it: no start
-- script, no workflow, no migration.
--
-- WHAT IT IS. The database role of the box, the small service that will serve
-- sandboxed custom code (services/box), and the hardening that keeps a stolen
-- password for that role from reaching beyond the box. The box is the one host
-- that serves customer code, so its password is the one most likely to be
-- stolen. With this file applied, that password cannot be used to stall the
-- application or to fill the database's disk.
--
-- WHO RUNS IT. Once per database, by a superuser (on Coolify the database's
-- own bootstrap user), with `psql -v ON_ERROR_STOP=1`, AFTER
-- prisma/sql/commerce-roles.sql (it grants to the two commerce roles and stops
-- if they do not exist). It is idempotent: running it again changes nothing
-- and fails nothing, and re-applying it is how an upgrade of this file, or a
-- restore of a dump, gets the same shape again. It names no database: every
-- database-level statement uses current_database().
--
-- NO PASSWORD, NO LOGIN. The role is created NOLOGIN. The operator's script
-- gives it a login and a freshly generated password and writes the connection
-- string into the box's own Infisical project (plan, D12). Re-running this
-- file never takes the LOGIN attribute away again.
--
-- WHAT IT DOES NOT DO.
--   - It grants nothing on any table, view or function of the application. The
--     one thing the box may call, the function box_document(text, text),
--     belongs to the application's migration (plan, slice C1b), which is not
--     approved; that migration grants EXECUTE on it to box_reader.
--   - It does not touch other databases of the cluster (see "What is left").
--   - It does not grant TEMPORARY to anyone. commerce-roles.sql already takes
--     it from PUBLIC and the application's roles do without it; this file only
--     takes it away again, in case it is applied to a database where it came
--     back.
--
-- WHAT IT TAKES FROM PUBLIC, IN THIS DATABASE, AND WHO GETS IT BACK BY NAME.
--   1. EXECUTE on every advisory lock function (pg_catalog, names starting
--      pg_advisory_ or pg_try_advisory_). The application takes such locks as
--      commerce_app (Books, the asset delete trigger) and as commerce_ddl (the
--      start step and provisioning), so those two get EXECUTE by name. The
--      bootstrap superuser (Prisma migrations, sites, domains) needs no grant.
--      box_reader gets none: it can no longer hold a lock the application
--      waits for.
--   2. EXECUTE on every large object function (lo_*, loread, lowrite). Nobody
--      gets it back: the application stores no large objects.
--   3. CONNECT on this database. commerce_app and commerce_ddl already hold it
--      by name (commerce-roles.sql); box_reader gets it here. ANY OTHER
--      NON-SUPERUSER LOGIN ROLE OF THE REAL DATABASE LOSES ITS CONNECTION
--      RIGHT: run prisma/sql/box-reader-preflight.sql first and grant CONNECT
--      by name to every role it lists that should keep it.
--   4. TEMPORARY on this database (already taken by commerce-roles.sql).
--
-- WHAT IT SETS ON box_reader.
--   - No superuser, database creation, role creation, replication or row
--     security bypass, no inherited role, at most 4 connections.
--   - temp_file_limit 0: it can write no temporary file (a sort or hash that
--     does not fit in memory fails). Only a superuser can change this setting,
--     so the role cannot lift it.
--   - statement_timeout 2s, idle_in_transaction_session_timeout 5s,
--     idle_session_timeout 60s. These are defaults a session can change, so
--     they bound the box, not a thief.
--
-- WHAT IS LEFT, stated so nobody takes this file for more than it is. Each is
-- held as a stated residual by the rehearsal test:
--   - The role can read the catalogs: names of tables, columns, functions and
--     roles, and the text of functions. Never a row of the application.
--   - The role can change its own password and its own defaults (Postgres
--     lets every role do that). A thief could set a one millisecond statement
--     timeout that survives a password rotation; re-applying this file puts
--     the defaults back, and the operator's script should check them.
--   - The role can hold its 4 connections.
--   - The role can connect to the other databases of the cluster (postgres,
--     template1) as long as PUBLIC may: closing that is a cluster-wide change,
--     or a rule in pg_hba.conf limiting box_reader to this database, and is
--     for the operator step O1.
--   - Any function outside pg_catalog that the application leaves executable
--     by PUBLIC. The rehearsal lists them; today there is none.
--
-- ROLLBACK: prisma/sql/box-reader-rollback.sql gives PUBLIC back what this
-- file took and takes the login away from box_reader.
--
-- REQUIRES POSTGRES 16 OR LATER, like commerce-roles.sql.

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'box-reader.sql needs Postgres 16 or later (found %)',
      current_setting('server_version');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_ddl') THEN
    RAISE EXCEPTION 'box-reader.sql must be applied after commerce-roles.sql (commerce_app or commerce_ddl is missing)';
  END IF;
END
$$;

-- =====================================================================
-- The role
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'box_reader') THEN
    CREATE ROLE box_reader NOLOGIN;
  END IF;
END
$$;

-- Every power named, so a re-run also takes away one that was added by hand.
-- LOGIN is not named: the operator's script grants it, and a re-run keeps it.
ALTER ROLE box_reader NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 4;

-- It is a member of no role and no role is a member of it.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member, pg_get_userbyid(grantor) AS grantor
      FROM pg_auth_members
     WHERE roleid = 'box_reader'::regrole OR member = 'box_reader'::regrole
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE', m.role, m.member, m.grantor);
  END LOOP;
END
$$;

-- Defaults. Set again on every run, so a default the role changed for itself is put back.
ALTER ROLE box_reader RESET ALL;
ALTER ROLE box_reader SET statement_timeout = '2s';
ALTER ROLE box_reader SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE box_reader SET idle_session_timeout = '60s';
-- Only a superuser can change temp_file_limit, so the role cannot lift this one.
ALTER ROLE box_reader SET temp_file_limit = 0;

-- =====================================================================
-- This database: who may connect, and no temporary tables for PUBLIC
-- =====================================================================

DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  -- The two commerce roles already hold CONNECT by name (commerce-roles.sql); granted again so this
  -- file is safe whatever state that grant is in.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO commerce_app, commerce_ddl, box_reader', current_database());
  -- Taken from box_reader by name too, in case it was ever granted by name.
  EXECUTE format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM box_reader', current_database());
END
$$;

-- =====================================================================
-- Advisory locks: the application's two roles by name, nobody through PUBLIC
-- =====================================================================
--
-- Listed from the catalog, not by hand: every signature of every variant
-- (session and transaction, exclusive and shared, waiting and trying, and the
-- unlocks), whatever this server version has.

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname LIKE 'pg\_advisory\_%' OR p.proname LIKE 'pg\_try\_advisory\_%')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.signature);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM box_reader', f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO commerce_app, commerce_ddl', f.signature);
  END LOOP;
END
$$;

-- =====================================================================
-- Large objects: nobody through PUBLIC
-- =====================================================================

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname LIKE 'lo\_%' OR p.proname IN ('loread', 'lowrite'))
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.signature);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM box_reader', f.signature);
  END LOOP;
END
$$;
