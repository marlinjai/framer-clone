-- prisma/sql/box-reader-rollback.sql
--
-- The way back from prisma/sql/box-reader.sql. PREPARED AND REHEARSED OFFLINE
-- ONLY, like that file.
--
-- WHO RUNS IT. A superuser, with `psql -f`, on the database box-reader.sql was
-- applied to. Idempotent. Never paste it, or part of it, into an interactive
-- session: there an error returns psql to its prompt instead of ending the run,
-- and the rest of the pasted text would go on. The file sets ON_ERROR_STOP on
-- and ON_ERROR_ROLLBACK off itself (the `\set` lines below), so `psql -f` stops
-- at the first error and exits with a non-zero status whatever was given with
-- `-v`, and no error is quietly undone while the run goes on. Those lines are
-- psql commands, which another client does not understand. Step 3's safety does
-- not rest on any of this: its check and its grants are one statement, so a
-- check that fails undoes every grant with it, with or without those settings
-- and whether or not autocommit is on (with autocommit off, steps 2 and 3 share
-- one transaction, which changes nothing of this).
--
-- NEVER AT THE SAME TIME AS THE OPERATOR'S ROLE SCRIPT (O1). Step 3's check
-- takes no lock on the role: an `ALTER ROLE box_reader LOGIN` committed while
-- step 3 runs would leave the box able to log in with PUBLIC's rights back.
--
-- WHAT IT DOES, in three steps, in this order:
--   1. One transaction: it takes the login away from box_reader, and its
--      grant of CONNECT by name. From the commit on, no new session of the
--      box can start. (NOLOGIN is what stops it; the CONNECT grant by name is
--      taken so nothing box-reader.sql gave the role stays behind.)
--   2. It lifts the statement timeout for its own session (the step waits at
--      least a second, and a short timeout on the operator's role would stop
--      it every time), then ends every session box_reader still has open and
--      waits for each to be gone, up to 5 seconds. A login that had passed
--      its checks just before step 1 committed appears in the list of
--      sessions only at the end of its startup, a few milliseconds later, so
--      the step waits a second and looks again, and ends whatever it finds,
--      until a look after that second finds nothing. If sessions are still
--      there after five rounds it stops with an error, before PUBLIC gets
--      anything back. On Postgres 17 and later a short transaction_timeout on
--      the operator's role would end the session in this step (the file does
--      not lift it); that stops the file on the safe side.
--   3. One statement (in a transaction of its own unless autocommit is off).
--      First it checks again that box_reader cannot log in and has no
--      session, reading the list of sessions afresh, and stops with an error
--      otherwise; the error undoes the whole statement, so this step gives
--      nothing back whichever psql settings it ran under or where the file
--      was cut short. Then it gives
--      PUBLIC back, in this database, what box-reader.sql took: CONNECT
--      on the database, then EXECUTE on the advisory lock functions, on the
--      large object functions and on pg_logical_emit_message. So every role
--      can do again what it could do before. It never touches lo_import and
--      lo_export, which Postgres keeps from PUBLIC (they read and write files
--      of the server) and which box-reader.sql therefore never had to take.
-- So no session of the box runs with PUBLIC's rights back, short of a startup
-- slower than a second: a login that passed its checks before step 1
-- committed and appears in the list of sessions more than a second later is
-- not seen by step 2 (nor by step 3's check, if it appears later still). If
-- the file stops after step 1 or 2, the box is shut out and PUBLIC still
-- lacks those rights, which is the safe side; run it again and it finishes.
-- It does not drop the role (a role that holds a grant cannot be dropped
-- without also dropping the grant, and the application's migration may have
-- given it one).
--
-- CATALOG NAMES (pg_stat_activity, pg_terminate_backend, format and the
-- others) are not qualified, so the file sets its own search path (pg_catalog,
-- then pg_temp) right after the `\set` lines, whatever path the session, the
-- database or the role had. The default path ("$user", public) is NOT safe
-- for a superuser: pg_catalog comes first only between functions with the
-- same argument types, and a function in public with a closer match, which
-- commerce_ddl may create there, would run with the superuser's rights.
--
-- IT ASSUMES that before box-reader.sql PUBLIC held what Postgres gives it by
-- default. If the real database had already taken one of these rights from
-- PUBLIC before box-reader.sql was applied, this file would give it back. The
-- preflight file shows only part of that (CONNECT on the database, and how
-- many advisory lock functions PUBLIC may execute), so keep its output from
-- before; it does not show the large object functions or
-- pg_logical_emit_message.
--
-- WHAT IT LEAVES AS IT IS.
--   - TEMPORARY stays taken from PUBLIC: that was commerce-roles.sql's doing
--     before box-reader.sql, not this file's to give back.
--   - EXECUTE on box_document for box_reader stays: the migration grants it
--     too, so taking it here would only last until the next start, and without
--     a login the role cannot use it.
--   - The grants by name to commerce_app and commerce_ddl stay. They are
--     harmless with PUBLIC holding the same right, and removing them would
--     only matter if box-reader.sql were applied again.
--   - "Back" means the same rights for everyone, as has_function_privilege and
--     has_database_privilege report them. The stored access lists are not
--     byte for byte what they were (Postgres stores a list it was given where
--     it stored none before); the rehearsal test compares the rights.

\set ON_ERROR_STOP on
\set ON_ERROR_ROLLBACK off

-- Every name below resolves in pg_catalog and nowhere else: under the default
-- path ("$user", public) a function someone created in public with a closer
-- argument type (pg_sleep(integer), format(text, name)) would win over the
-- built-in and run with the superuser's rights.
SET search_path = pg_catalog, pg_temp;

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

-- Step 2. Its open sessions are ended, and gone, before PUBLIC gets anything
-- back.
-- For this session only: the step waits at least a second, whatever timeout
-- the role has.
SET statement_timeout = 0;

DO $$
DECLARE
  a record;
  still_open int;
  round int := 0;
BEGIN
  LOOP
    round := round + 1;
    FOR a IN SELECT pid FROM pg_stat_activity WHERE usename = 'box_reader' AND pid <> pg_backend_pid() LOOP
      -- Waits until the session is gone, up to 5 seconds.
      PERFORM pg_terminate_backend(a.pid, 5000);
    END LOOP;
    -- A login that passed its checks before step 1 committed shows up only at
    -- the end of its startup, so the step waits and looks again.
    PERFORM pg_sleep(1);
    -- Read the sessions afresh: within one transaction Postgres would show the
    -- list read above again.
    PERFORM pg_stat_clear_snapshot();
    SELECT count(*) INTO still_open FROM pg_stat_activity
     WHERE usename = 'box_reader' AND pid <> pg_backend_pid();
    EXIT WHEN still_open = 0;
    IF round >= 5 THEN
      RAISE EXCEPTION 'box-reader-rollback.sql: % session(s) of box_reader did not end; PUBLIC has been given nothing back yet. Run this file again.', still_open;
    END IF;
  END LOOP;
END
$$;

-- Step 3. PUBLIC gets back what box-reader.sql took, whole or not at all: the
-- check and every grant are one statement, so an error anywhere in it, the
-- check's included, undoes all of it.
BEGIN;

DO $$
DECLARE
  open_sessions int;
  f record;
BEGIN
  -- Checked again here, whatever happened before: the box cannot log in and has
  -- no session.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'box_reader' AND rolcanlogin) THEN
    RAISE EXCEPTION 'box-reader-rollback.sql: box_reader can still log in; '
      'PUBLIC has been given nothing back. Run the whole file again.';
  END IF;
  -- Read afresh: with autocommit off this shares a transaction with step 2,
  -- whose last look Postgres would otherwise show again.
  PERFORM pg_stat_clear_snapshot();
  SELECT count(*) INTO open_sessions FROM pg_stat_activity
   WHERE usename = 'box_reader' AND pid <> pg_backend_pid();
  IF open_sessions > 0 THEN
    RAISE EXCEPTION 'box-reader-rollback.sql: % session(s) of box_reader are open; '
      'PUBLIC has been given nothing back. Run the whole file again.', open_sessions;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO PUBLIC', current_database());

  FOR f IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname LIKE 'pg!_advisory!_%' ESCAPE '!'
            OR p.proname LIKE 'pg!_try!_advisory!_%' ESCAPE '!'
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
