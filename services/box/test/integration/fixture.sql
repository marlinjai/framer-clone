-- services/box/test/integration/fixture.sql
--
-- TEST FIXTURE ONLY. Never applied to a real database, and not a migration.
--
-- It stands in for the part of the application's schema the box depends on,
-- so the box can be tested against a real Postgres before the application's
-- migration exists. That migration is parked (slice C1b of
-- docs/plans/2026-11-02-sandboxed-custom-code.md). What it has to meet is the
-- last objects here (decision D18), and the tests in this folder hold the box
-- to them:
--
--   1. the function `box_document(site_id text, sha256 text)`, returning at
--      most one row of exactly these columns:
--        document text, live boolean, subdomain_labels text[], custom_hostnames text[]
--      - SECURITY DEFINER with a fixed search_path, so the caller needs no
--        right on any table; EXECUTE revoked from PUBLIC;
--      - `live` is `custom_code_enabled AND blocked_at IS NULL`;
--      - `document` is NULL unless `live`, so the role can never read the
--        code of a blocked blob or of a site that switched custom code off;
--      - `subdomain_labels` leaves out every label kept for branch preview
--        links (decision D13); the box drops them a second time;
--      - `custom_hostnames` holds live claims only (verified or active).
--      A function and not a view: a view could be listed (`SELECT *`), which
--      would hand every site id, hash, draft document and host name to
--      whoever holds the role's password. The function answers only for a
--      pair the caller already knows.
--   2. the role `box_reader`: LOGIN, CONNECTION LIMIT 4, EXECUTE on that
--      function and nothing else: no table, no view, no temporary table.
--      Its timeouts (statement 2s, idle in transaction 5s, idle session 60s)
--      are defaults a session can change, so they bound the box, not someone
--      who stole the password; what bounds that person is the connection
--      limit and the residuals written down in decision D20.
--
-- The tables above them are cut down to what the function reads. The real
-- ones are the application's (prisma/schema.prisma) and are not described here.

CREATE TABLE sites (
  id text PRIMARY KEY,
  custom_code_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE site_domains (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  subdomain text UNIQUE,
  custom_hostname text UNIQUE,
  verification_status text NOT NULL DEFAULT 'pending'
);

CREATE TABLE custom_code_blobs (
  site_id text NOT NULL,
  sha256 text NOT NULL,
  document text NOT NULL,
  declaration jsonb NOT NULL,
  title text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  blocked_at timestamptz,
  PRIMARY KEY (site_id, sha256)
);

-- Stands for everything else the application keeps: the box's role must not read it.
CREATE TABLE application_rows (
  id text PRIMARY KEY,
  secret text NOT NULL
);
INSERT INTO application_rows VALUES ('1', 'not for the box');

CREATE FUNCTION box_document(p_site_id text, p_sha256 text)
RETURNS TABLE (document text, live boolean, subdomain_labels text[], custom_hostnames text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    CASE WHEN s.custom_code_enabled AND b.blocked_at IS NULL THEN b.document END,
    (s.custom_code_enabled AND b.blocked_at IS NULL),
    COALESCE(
      (SELECT array_agg(d.subdomain ORDER BY d.subdomain)
         FROM public.site_domains d
        WHERE d.site_id = b.site_id AND d.subdomain IS NOT NULL AND d.subdomain NOT LIKE 'preview-%'),
      ARRAY[]::text[]),
    COALESCE(
      (SELECT array_agg(d.custom_hostname ORDER BY d.custom_hostname)
         FROM public.site_domains d
        WHERE d.site_id = b.site_id AND d.custom_hostname IS NOT NULL AND d.verification_status IN ('verified', 'active')),
      ARRAY[]::text[])
  FROM public.custom_code_blobs b
  JOIN public.sites s ON s.id = b.site_id
  WHERE b.site_id = p_site_id AND b.sha256 = p_sha256
$$;
REVOKE ALL ON FUNCTION box_document(text, text) FROM PUBLIC;

-- The role. Its password is set by the test at run time, from random bytes; none is written here.
CREATE ROLE box_reader LOGIN CONNECTION LIMIT 4;
ALTER ROLE box_reader SET statement_timeout = '2s';
ALTER ROLE box_reader SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE box_reader SET idle_session_timeout = '60s';
GRANT EXECUTE ON FUNCTION box_document(text, text) TO box_reader;

-- No role gets a temporary table through PUBLIC in this database. (In the real database this line is
-- part of what C1b has to weigh against the application's own roles, see decision D20.)
DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $$;
