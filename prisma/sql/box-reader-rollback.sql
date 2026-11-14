-- prisma/sql/box-reader-rollback.sql
--
-- The way back from prisma/sql/box-reader.sql. PREPARED AND REHEARSED OFFLINE
-- ONLY, like that file.
--
-- WHO RUNS IT. A superuser, with `psql -v ON_ERROR_STOP=1`, on the database
-- box-reader.sql was applied to. Idempotent.
--
-- WHAT IT DOES. It gives PUBLIC back, in this database, what box-reader.sql
-- took: EXECUTE on the advisory lock functions and on the large object
-- functions, and CONNECT on the database. So every role can do again what it
-- could do before. It takes the login away from box_reader, so the box's
-- password stops working at once; it does not drop the role (a role that
-- holds a grant cannot be dropped without also dropping the grant, and the
-- application's migration may have given it one).
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

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname LIKE 'pg\_advisory\_%' OR p.proname LIKE 'pg\_try\_advisory\_%'
            OR p.proname LIKE 'lo\_%' OR p.proname IN ('loread', 'lowrite'))
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', f.signature);
  END LOOP;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO PUBLIC', current_database());
END
$$;

-- lo_import and lo_export were never PUBLIC's (Postgres keeps them to superusers
-- and to members of the server file roles): taken away again.
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text, oid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_export(oid, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'box_reader') THEN
    ALTER ROLE box_reader NOLOGIN;
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM box_reader', current_database());
  END IF;
END
$$;
