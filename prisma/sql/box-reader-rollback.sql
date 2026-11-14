-- prisma/sql/box-reader-rollback.sql
--
-- The way back from prisma/sql/box-reader.sql. PREPARED AND REHEARSED OFFLINE
-- ONLY, like that file.
--
-- WHO RUNS IT. A superuser, with `psql -v ON_ERROR_STOP=1`, on the database
-- box-reader.sql was applied to. Idempotent.
--
-- WHAT IT DOES, in one transaction (whole or not at all). It gives PUBLIC
-- back, in this database, what box-reader.sql took: EXECUTE on the advisory
-- lock functions and on the large object functions, and CONNECT on the
-- database. So every role can do again what it could do before. It never
-- touches lo_import and lo_export, which Postgres keeps from PUBLIC (they read
-- and write files of the server) and which box-reader.sql therefore never had
-- to take. It takes the login and the connection right away from box_reader
-- and ends the sessions that role has open, so the box's password stops
-- working at once, also for a session that was already connected. It does not
-- drop the role (a role that holds a grant cannot be dropped without also
-- dropping the grant, and the application's migration may have given it one).
--
-- IT ASSUMES that before box-reader.sql PUBLIC held what Postgres gives it by
-- default. If the real database had already taken one of these rights from
-- PUBLIC before box-reader.sql was applied, this file would give it back; the
-- preflight file shows what PUBLIC holds, so keep its output from before.
--
-- WHAT IT LEAVES AS IT IS.
--   - TEMPORARY stays taken from PUBLIC: that was commerce-roles.sql's doing
--     before box-reader.sql, not this file's to give back.
--   - The grants by name to commerce_app and commerce_ddl stay. They are
--     harmless with PUBLIC holding the same right, and removing them would
--     only matter if box-reader.sql were applied again.
--   - "Back" means the same rights for everyone, as has_function_privilege and
--     has_database_privilege report them. The stored access lists are not
--     byte for byte what they were (Postgres stores a list it was given where
--     it stored none before); the rehearsal test compares the rights.

BEGIN;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname LIKE 'pg!_advisory!_%' ESCAPE '!' OR p.proname LIKE 'pg!_try!_advisory!_%' ESCAPE '!'
            OR p.proname LIKE 'lo!_%' ESCAPE '!' OR p.proname IN ('loread', 'lowrite'))
       -- Never PUBLIC's: they read and write files of the server.
       AND p.proname NOT IN ('lo_import', 'lo_export')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', f.signature);
  END LOOP;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO PUBLIC', current_database());
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'box_reader') THEN
    ALTER ROLE box_reader NOLOGIN;
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM box_reader', current_database());
    -- A session that is already connected would keep running, now with PUBLIC's rights back.
    PERFORM pg_terminate_backend(a.pid) FROM pg_stat_activity a WHERE a.usename = 'box_reader' AND a.pid <> pg_backend_pid();
  END IF;
END
$$;

COMMIT;
