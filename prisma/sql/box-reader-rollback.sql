-- prisma/sql/box-reader-rollback.sql
--
-- The way back from prisma/sql/box-reader.sql. PREPARED AND REHEARSED OFFLINE
-- ONLY, like that file.
--
-- WHO RUNS IT. A superuser, with `psql -v ON_ERROR_STOP=1`, on the database
-- box-reader.sql was applied to. Idempotent.
--
-- WHAT IT DOES, in three steps, in this order:
--   1. One transaction: it takes the login away from box_reader, and its
--      grant of CONNECT by name. From the commit on, no new session of the
--      box can start. (NOLOGIN is what stops it; the CONNECT grant by name is
--      taken so nothing box-reader.sql gave the role stays behind.)
--   2. It ends every session box_reader still has open and waits for each to
--      be gone, up to 5 seconds. If one is still there it stops with an error,
--      before PUBLIC gets anything back.
--   3. One transaction: it gives PUBLIC back, in this database, what
--      box-reader.sql took: CONNECT on the database, then EXECUTE on the
--      advisory lock functions, on the large object functions and on
--      pg_logical_emit_message. So every role can do again what it could do
--      before. It never touches lo_import and lo_export, which Postgres keeps
--      from PUBLIC (they read and write files of the server) and which
--      box-reader.sql therefore never had to take.
-- So no session of the box ever runs with PUBLIC's rights back. If the file
-- stops after step 1 or 2, the box is shut out and PUBLIC still lacks those
-- rights, which is the safe side; run it again and it finishes. It does not
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

-- Step 1. The box is shut out.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'box_reader') THEN
    ALTER ROLE box_reader NOLOGIN;
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM box_reader', current_database());
  END IF;
END
$$;

COMMIT;

-- Step 2. Its open sessions are ended, and gone, before PUBLIC gets anything back.
DO $$
DECLARE
  a record;
  still_open int;
BEGIN
  FOR a IN SELECT pid FROM pg_stat_activity WHERE usename = 'box_reader' AND pid <> pg_backend_pid() LOOP
    -- Waits until the session is gone, up to 5 seconds.
    PERFORM pg_terminate_backend(a.pid, 5000);
  END LOOP;
  -- Read the sessions afresh: within one statement Postgres would show the list read above again.
  PERFORM pg_stat_clear_snapshot();
  SELECT count(*) INTO still_open FROM pg_stat_activity WHERE usename = 'box_reader';
  IF still_open > 0 THEN
    RAISE EXCEPTION 'box-reader-rollback.sql: % session(s) of box_reader did not end; PUBLIC has been given nothing back yet. Run this file again.', still_open;
  END IF;
END
$$;

-- Step 3. PUBLIC gets back what box-reader.sql took, whole or not at all.
BEGIN;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO PUBLIC', current_database());
END
$$;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname LIKE 'pg!_advisory!_%' ESCAPE '!' OR p.proname LIKE 'pg!_try!_advisory!_%' ESCAPE '!'
            OR p.proname LIKE 'lo!_%' ESCAPE '!' OR p.proname IN ('loread', 'lowrite')
            OR p.proname = 'pg_logical_emit_message')
       -- Never PUBLIC's: they read and write files of the server.
       AND p.proname NOT IN ('lo_import', 'lo_export')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', f.signature);
  END LOOP;
END
$$;

COMMIT;
