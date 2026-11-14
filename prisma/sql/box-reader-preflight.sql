-- prisma/sql/box-reader-preflight.sql
--
-- READ ONLY. It changes nothing. Run it on the real database, as a superuser,
-- BEFORE prisma/sql/box-reader.sql, and read what it prints. The rehearsal ran
-- against a database built from this repository's migrations, so it cannot
-- know the roles and functions that exist only in the real one. This file
-- shows them.
--
--   psql -v ON_ERROR_STOP=1 -U <bootstrap superuser> -d <database> -f prisma/sql/box-reader-preflight.sql

\echo '== 1. Login roles that would LOSE CONNECT on this database (they have it only through PUBLIC).'
\echo '==    Expected: none. For each role listed that should keep it: GRANT CONNECT ON DATABASE <db> TO <role>;'
SELECT r.rolname AS role
  FROM pg_roles r
  CROSS JOIN pg_database d
 WHERE d.datname = current_database()
   AND r.rolcanlogin
   AND NOT r.rolsuper
   AND r.rolname NOT IN ('commerce_app', 'commerce_ddl', 'box_reader')
   AND has_database_privilege(r.oid, d.oid, 'CONNECT')
   AND NOT EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
          WHERE a.grantee = r.oid AND a.privilege_type = 'CONNECT')
 ORDER BY 1;

\echo '== 2. Non-superuser roles besides commerce_app and commerce_ddl (roles that cannot log in are listed too:'
\echo '==    another role may act through them). Any of them that takes advisory locks needs:'
\echo '==    a line for it in box-reader.sql. Expected: only box_reader, or none.'
SELECT rolname AS role, rolcanlogin AS can_log_in
  FROM pg_roles
 WHERE NOT rolsuper
   AND rolname NOT LIKE 'pg\_%'
   AND rolname NOT IN ('commerce_app', 'commerce_ddl')
 ORDER BY 1;

\echo '== 3. Is the role the application uses for Prisma (DATABASE_URL) a superuser? It must be, or it needs'
\echo '==    EXECUTE on the advisory lock functions by name (prisma migrate deploy takes one). All superusers:'
SELECT rolname AS superuser FROM pg_roles WHERE rolsuper ORDER BY 1;

\echo '== 4. Large objects in this database. Expected: 0. If not, something stores them and box-reader.sql would'
\echo '==    take its right to; find out what before applying.'
SELECT count(*) AS large_objects FROM pg_largeobject_metadata;

\echo '== 5. Functions outside the system schemas that PUBLIC may execute (box_reader could call them).'
\echo '==    Expected: none.'
SELECT p.oid::regprocedure AS function
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg\_%'
   AND has_schema_privilege('public', n.oid, 'USAGE')
   AND EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
 ORDER BY 1;

\echo '== 6. What PUBLIC holds on this database now (TEMPORARY should already be gone, by commerce-roles.sql).'
SELECT a.privilege_type
  FROM pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
 WHERE d.datname = current_database() AND a.grantee = 0
 ORDER BY 1;

\echo '== 7. Other databases of this cluster that PUBLIC may connect to (box_reader could too; box-reader.sql does'
\echo '==    not change that, see its header).'
SELECT d.datname AS database
  FROM pg_database d
 WHERE d.datname <> current_database()
   AND d.datallowconn
   AND EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT')
 ORDER BY 1;

\echo '== 8. Is box-reader.sql already applied? (advisory lock functions PUBLIC may still execute; 0 after it)'
SELECT count(*) AS advisory_lock_functions_open_to_public
  FROM pg_proc p
 WHERE p.pronamespace = 'pg_catalog'::regnamespace
   AND (p.proname LIKE 'pg\_advisory\_%' OR p.proname LIKE 'pg\_try\_advisory\_%')
   AND EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
