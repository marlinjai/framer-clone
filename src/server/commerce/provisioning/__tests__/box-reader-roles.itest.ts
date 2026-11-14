// src/server/commerce/provisioning/__tests__/box-reader-roles.itest.ts
//
// THE REHEARSAL of prisma/sql/box-reader.sql (the database role of the box,
// the service that will serve sandboxed custom code, and the hardening that
// keeps a stolen password for it from reaching beyond the box) and of its
// rollback, on a throwaway Postgres 16 in the production role topology. It is
// offline preparation only: nothing here touches a real database, and the
// file is applied nowhere else (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// decisions D20 and D24).
//
// The database is built the way a deploy builds it: commerce-roles.sql as the
// superuser, `prisma migrate deploy` as the superuser, the container start
// step and a company's provisioning as the NON-superuser commerce_ddl. That is
// a copy made from this repository, not from production: roles and functions
// that exist only in the real database are not in it (box-reader-preflight.sql
// is what shows those).
//
// What it holds:
//   1. A control first: with the advisory lock functions taken from PUBLIC and
//      given to nobody, the application's own paths fail (the start step as
//      commerce_ddl, a Books lock and the asset delete trigger as
//      commerce_app). So those paths really depend on what the file grants.
//   2. With the file applied (twice): the same paths work.
//   3. box_reader, by allow-list: what it may do and nothing else, asked of
//      the catalog (has_*_privilege) and tried for real as that role.
//   4. The residuals the file's header states, each asserted as it is, so a
//      change in either direction is noticed.
//   5. Re-applying commerce-roles.sql afterwards changes nothing; the rollback
//      gives PUBLIC its rights back and takes the box's login away; applying
//      the file again closes everything again.
//   6. What a dump and restore does to the rights.
//
// No password literal exists anywhere: the container uses TRUST auth, as
// roles.itest.ts does, and the one password this test sets is random bytes.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { provisionCommerceTenant } from '../provision';
import { runCommerceDeployMigrations } from '../deploy';

const DB_NAME = 'framer_clone_box_reader_test';
const SQL_DIR = path.resolve(__dirname, '../../../../../prisma/sql');
const FILES = ['commerce-roles.sql', 'box-reader.sql', 'box-reader-rollback.sql', 'box-reader-preflight.sql'] as const;
type SqlFile = (typeof FILES)[number];

let container: StartedTestContainer | undefined;
let host: string;
let port: number;
let su: postgres.Sql | undefined;
const opened: postgres.Sql[] = [];

const urlOf = (user: string, database = DB_NAME) => `postgresql://${user}@${host}:${port}/${database}`;

/** A connection as a role. Closed at the end of the test that opened it (box_reader may hold only four). */
function as(user: string, database = DB_NAME): postgres.Sql {
  const sql = postgres(urlOf(user, database), { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 10 });
  opened.push(sql);
  return sql;
}

/** The error code a statement fails with, or 'ok'. */
async function codeOf(run: () => PromiseLike<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
}

/** Applies a file the way the operator would: psql, stop at the first error. Returns what it printed. */
async function apply(file: SqlFile, database = DB_NAME): Promise<string> {
  const { exitCode, output } = await container!.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres', '-d', database, '-f', `/tmp/${file}`]);
  if (exitCode !== 0) throw new Error(`${file} failed (exit ${exitCode}): ${output}`);
  return output;
}

/**
 * How many of the advisory lock functions, and of the large object functions, a role may execute,
 * and how many there are. Selected exactly as the files select them.
 */
async function mayExecute(role: string, sql: postgres.Sql = su!): Promise<{ locks: { may: number; of: number }; largeObjects: { may: number; of: number } }> {
  const [locks] = await sql`
    SELECT count(*) FILTER (WHERE has_function_privilege(${role}, p.oid, 'EXECUTE'))::int AS may, count(*)::int AS of
      FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname LIKE 'pg\\_advisory\\_%' OR p.proname LIKE 'pg\\_try\\_advisory\\_%')
  `;
  const [largeObjects] = await sql`
    SELECT count(*) FILTER (WHERE has_function_privilege(${role}, p.oid, 'EXECUTE'))::int AS may, count(*)::int AS of
      FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname LIKE 'lo\\_%' OR p.proname IN ('loread', 'lowrite'))
  `;
  return {
    locks: { may: locks!.may as number, of: locks!.of as number },
    largeObjects: { may: largeObjects!.may as number, of: largeObjects!.of as number },
  };
}

/** Takes the advisory lock functions from PUBLIC and gives them to nobody, or gives them back: the control. */
async function lockFunctionsForPublic(give: boolean): Promise<void> {
  if (give) {
    await su!`
      DO $$ DECLARE f record; BEGIN
        FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
                  WHERE p.pronamespace = 'pg_catalog'::regnamespace
                    AND (p.proname LIKE 'pg\\_advisory\\_%' OR p.proname LIKE 'pg\\_try\\_advisory\\_%')
        LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', f.signature); END LOOP;
      END $$
    `;
  } else {
    await su!`
      DO $$ DECLARE f record; BEGIN
        FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
                  WHERE p.pronamespace = 'pg_catalog'::regnamespace
                    AND (p.proname LIKE 'pg\\_advisory\\_%' OR p.proname LIKE 'pg\\_try\\_advisory\\_%')
        LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.signature); END LOOP;
      END $$
    `;
  }
}

/** The whole shape this test cares about, for one role, as the catalog reports it. */
async function rightsOf(role: string) {
  const [db] = await su!`
    SELECT has_database_privilege(${role}, current_database(), 'CONNECT') AS connect,
           has_database_privilege(${role}, current_database(), 'TEMPORARY') AS temporary,
           has_database_privilege(${role}, current_database(), 'CREATE') AS create
  `;
  return {
    connect: db!.connect as boolean,
    temporary: db!.temporary as boolean,
    create: db!.create as boolean,
    ...(await mayExecute(role)),
  };
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_DB: DB_NAME, POSTGRES_HOST_AUTH_METHOD: 'trust' })
    .withExposedPorts(5432)
    .withCopyFilesToContainer(FILES.map((file) => ({ source: path.join(SQL_DIR, file), target: `/tmp/${file}` })))
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  host = container.getHost();
  port = container.getMappedPort(5432);
  su = postgres(urlOf('postgres'), { max: 1, prepare: false, onnotice: () => {} });
  // A role nobody granted anything: it has exactly what PUBLIC has. It can log in, so "what PUBLIC
  // may do" can also be tried for real.
  await su`CREATE ROLE anyone_else LOGIN`;
}, 180_000);

afterEach(async () => {
  await Promise.all(opened.splice(0).map((sql) => sql.end({ timeout: 2 }).catch(() => {})));
});

afterAll(async () => {
  await su?.end();
  await container?.stop();
});

let schema: string;
let tenantGroupId: string;

describe('the database, built the way a deploy builds it', () => {
  it('commerce-roles.sql, the Prisma tier as the superuser, the start step and a company as commerce_ddl', async () => {
    await apply('commerce-roles.sql');
    await su!`ALTER ROLE commerce_app LOGIN`;
    await su!`ALTER ROLE commerce_ddl LOGIN`;
    execSync('pnpm exec prisma migrate deploy', { stdio: 'ignore', env: { ...process.env, DATABASE_URL: urlOf('postgres') } });
    const start = await runCommerceDeployMigrations({ ownerUrl: urlOf('commerce_ddl'), appUrl: urlOf('commerce_app'), log: () => {} });
    expect(start.role).toBe('commerce_ddl');
    tenantGroupId = randomUUID();
    const provisioned = await provisionCommerceTenant({ tenantGroupId, slug: 'box-reader-itest', connectionString: urlOf('commerce_ddl') });
    schema = provisioned.schema;
    expect(provisioned.applied.length).toBeGreaterThan(0);
  }, 240_000);

  it('before the file: PUBLIC may take advisory locks, use large objects and connect; nobody but the superuser has TEMPORARY', async () => {
    const anyone = await rightsOf('anyone_else');
    expect(anyone.connect).toBe(true);
    // commerce-roles.sql already took this from PUBLIC.
    expect(anyone.temporary).toBe(false);
    expect(anyone.locks.of).toBeGreaterThanOrEqual(16);
    expect(anyone.locks.may).toBe(anyone.locks.of);
    expect(anyone.largeObjects.of).toBeGreaterThanOrEqual(10);
    // lo_import and lo_export are kept from PUBLIC by Postgres itself.
    expect(anyone.largeObjects.may).toBe(anyone.largeObjects.of - 3);
    expect((await rightsOf('commerce_app')).temporary).toBe(false);
  });
});

/** The application's own paths that take an advisory lock, each as the role that takes it in production. */
async function applicationPaths(): Promise<Record<string, string>> {
  const app = as('commerce_app');
  const assetId = randomUUID();
  const sha = randomBytes(32).toString('hex');
  const tenantId = randomUUID();
  const results: Record<string, string> = {};

  // The container start step: it takes the deploy lock with pg_try_advisory_lock, as commerce_ddl.
  results['start step as commerce_ddl'] = await codeOf(() =>
    runCommerceDeployMigrations({ ownerUrl: urlOf('commerce_ddl'), appUrl: urlOf('commerce_app'), log: () => {} }),
  );
  // A company's first project: provisioning takes its lock, as commerce_ddl.
  results['provisioning as commerce_ddl'] = await codeOf(() =>
    provisionCommerceTenant({ tenantGroupId, slug: 'box-reader-itest', connectionString: urlOf('commerce_ddl') }),
  );
  // Books, as commerce_app: the transaction lock on a hashed key (repository/assets.ts, templates.ts,
  // upload/service.ts, importInvoices.ts) and its shared form (assets.ts).
  results['Books lock as commerce_app'] = await codeOf(() =>
    app.begin((tx) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${`books-assets:${tenantId}`}, 0))`),
  );
  results['Books shared lock as commerce_app'] = await codeOf(() => app.begin((tx) => tx`SELECT pg_advisory_xact_lock_shared(${42})`));
  // The asset delete trigger of tenant migration 014: it takes the logo's lock inside a DELETE, as
  // whoever deletes, here commerce_app, on a real row of the provisioned company schema.
  results['asset delete trigger as commerce_app'] = await codeOf(() =>
    app.begin(async (tx) => {
      await tx`
        INSERT INTO ${tx(schema)}."books_asset" ("id", "tenant_id", "kind", "content_type", "byte_size", "sha256", "width_px", "height_px", "content")
        VALUES (${assetId}, ${tenantId}, 'logo', 'image/png', 3, ${sha}, 1, 1, ${Buffer.from([1, 2, 3])})
      `;
      await tx`DELETE FROM ${tx(schema)}."books_asset" WHERE "id" = ${assetId}`;
    }),
  );
  await app.end({ timeout: 2 });
  return results;
}

const ALL_WORK = {
  'start step as commerce_ddl': 'ok',
  'provisioning as commerce_ddl': 'ok',
  'Books lock as commerce_app': 'ok',
  'Books shared lock as commerce_app': 'ok',
  'asset delete trigger as commerce_app': 'ok',
};

describe('the control: what the application loses when the rights are only taken away', () => {
  it('every path works before anything is changed', async () => {
    expect(await applicationPaths()).toEqual(ALL_WORK);
  }, 120_000);

  it('with the advisory lock functions taken from PUBLIC and given to nobody, every one of those paths fails', async () => {
    await lockFunctionsForPublic(false);
    try {
      const results = await applicationPaths();
      // Each fails, and for the reason in question: permission denied for a function (42501). The
      // two that run through the application's own code wrap or rethrow it; they are not 'ok'.
      expect(results['Books lock as commerce_app']).toBe('42501');
      expect(results['Books shared lock as commerce_app']).toBe('42501');
      expect(results['asset delete trigger as commerce_app']).toBe('42501');
      expect(results['start step as commerce_ddl']).not.toBe('ok');
      expect(results['provisioning as commerce_ddl']).not.toBe('ok');
      // And it is the missing right, not something else: the same call, directly, as commerce_ddl.
      const ddl = as('commerce_ddl');
      expect(await codeOf(() => ddl`SELECT pg_try_advisory_lock(1)`)).toBe('42501');
      expect(await codeOf(() => ddl`SELECT pg_advisory_lock(1)`)).toBe('42501');
    } finally {
      await lockFunctionsForPublic(true);
    }
    expect(await applicationPaths()).toEqual(ALL_WORK);
  }, 180_000);
});

describe('box-reader.sql applied', () => {
  it('applies cleanly, twice, and again after the role was given a login, which it keeps', async () => {
    await apply('box-reader.sql');
    await apply('box-reader.sql');
    await su!`ALTER ROLE box_reader LOGIN`;
    await apply('box-reader.sql');
    const [role] = await su!`
      SELECT rolsuper, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit, rolconnlimit, rolconfig
        FROM pg_roles WHERE rolname = 'box_reader'
    `;
    expect(role).toEqual({
      rolsuper: false,
      rolcanlogin: true,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolinherit: false,
      rolconnlimit: 4,
      rolconfig: ['statement_timeout=2s', 'idle_in_transaction_session_timeout=5s', 'idle_session_timeout=60s', 'temp_file_limit=0'],
    });
    const members = await su!`SELECT 1 FROM pg_auth_members WHERE roleid = 'box_reader'::regrole OR member = 'box_reader'::regrole`;
    expect(members).toHaveLength(0);
  });

  it('the application keeps every path that takes a lock', async () => {
    expect(await applicationPaths()).toEqual(ALL_WORK);
  }, 120_000);

  it('the two commerce roles hold the lock functions by name and nothing more than before', async () => {
    for (const role of ['commerce_app', 'commerce_ddl']) {
      const rights = await rightsOf(role);
      expect(rights.locks.may, role).toBe(rights.locks.of);
      expect(rights.largeObjects.may, role).toBe(0);
      expect(rights.connect, role).toBe(true);
      // Not granted by this file: commerce_app still cannot create a temporary table.
      expect(rights.temporary, role).toBe(false);
    }
    const app = as('commerce_app');
    expect(await codeOf(() => app`CREATE TEMP TABLE scratch (id int)`)).toBe('42501');
  });

  it('PUBLIC holds none of it any more: a role nobody granted anything cannot connect, lock or use large objects', async () => {
    const anyone = await rightsOf('anyone_else');
    expect(anyone).toEqual({
      connect: false,
      temporary: false,
      create: false,
      locks: { may: 0, of: anyone.locks.of },
      largeObjects: { may: 0, of: anyone.largeObjects.of },
    });
    const sql = as('anyone_else');
    // 42501: permission denied for the database.
    expect(await codeOf(() => sql`SELECT 1`)).toBe('42501');
  });
});

describe('box_reader, by allow-list', () => {
  it('may connect to this database, and holds nothing else the catalog knows of', async () => {
    const rights = await rightsOf('box_reader');
    expect(rights).toEqual({
      connect: true,
      temporary: false,
      create: false,
      locks: { may: 0, of: rights.locks.of },
      largeObjects: { may: 0, of: rights.largeObjects.of },
    });

    // No right of any kind on any table, view or sequence outside the system schemas.
    const relations = await su!`
      SELECT n.nspname || '.' || c.relname AS relation
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
         AND (has_table_privilege('box_reader', c.oid, 'SELECT') OR has_table_privilege('box_reader', c.oid, 'INSERT')
              OR has_table_privilege('box_reader', c.oid, 'UPDATE') OR has_table_privilege('box_reader', c.oid, 'DELETE')
              OR has_table_privilege('box_reader', c.oid, 'TRUNCATE') OR has_table_privilege('box_reader', c.oid, 'REFERENCES')
              OR has_table_privilege('box_reader', c.oid, 'TRIGGER'))
    `;
    expect(relations.map((row) => row.relation)).toEqual([]);

    // Functions outside the system schemas that it could reach and execute. Postgres lets PUBLIC
    // execute every new function, so each function the application's migrations create in `public`
    // shows up here. Today these are four, all trigger functions, which nobody can call directly
    // (the next test tries). The list is pinned: a new function here, above all one that is NOT a
    // trigger function, is something box_reader could call, and has to be looked at before it ships.
    // (The function the box is meant to call, box_document, belongs to the application's migration,
    // which is not part of this.)
    const functions = await su!`
      SELECT p.oid::regprocedure::text AS function, p.prorettype::regtype::text AS returns, p.prosecdef AS definer
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
         AND has_schema_privilege('box_reader', n.oid, 'USAGE')
         AND has_function_privilege('box_reader', p.oid, 'EXECUTE')
       ORDER BY 1
    `;
    expect(functions.map((row) => ({ ...row }))).toEqual([
      { function: 'site_branches_close_without_content()', returns: 'trigger', definer: false },
      { function: 'site_branches_site_is_main()', returns: 'trigger', definer: false },
      { function: 'site_domains_not_on_branch()', returns: 'trigger', definer: false },
      { function: 'sites_branch_parent_guard()', returns: 'trigger', definer: false },
    ]);

    // No schema it may create in, none but public it may use.
    const schemas = await su!`
      SELECT n.nspname AS schema, has_schema_privilege('box_reader', n.oid, 'USAGE') AS usage, has_schema_privilege('box_reader', n.oid, 'CREATE') AS create
        FROM pg_namespace n
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
         AND (has_schema_privilege('box_reader', n.oid, 'USAGE') OR has_schema_privilege('box_reader', n.oid, 'CREATE'))
    `;
    expect(schemas.map((row) => ({ ...row }))).toEqual([{ schema: 'public', usage: true, create: false }]);
  });

  it('tried for real, as box_reader: each thing a thief would reach for is refused', async () => {
    const box = as('box_reader');
    // A session of the application that really exists, by its process id.
    const app = as('commerce_app');
    const [{ pid }] = (await app`SELECT pg_backend_pid() AS pid`) as unknown as [{ pid: number }];
    const attempts: Record<string, () => PromiseLike<unknown>> = {
      'take the lock prisma migrate takes': () => box`SELECT pg_advisory_lock(72707369)`,
      'try a lock': () => box`SELECT pg_try_advisory_lock(1)`,
      'take a transaction lock': () => box`SELECT pg_advisory_xact_lock(1)`,
      'take a shared lock': () => box`SELECT pg_advisory_lock_shared(1)`,
      'take a two-key lock': () => box`SELECT pg_advisory_lock(1, 2)`,
      'release every lock': () => box`SELECT pg_advisory_unlock_all()`,
      'create a large object': () => box`SELECT lo_creat(-1)`,
      'create a large object with content': () => box`SELECT lo_from_bytea(0, '\\x00')`,
      'create a temporary table': () => box`CREATE TEMP TABLE scratch (id int)`,
      'create a table': () => box`CREATE TABLE public.box_owned (id int)`,
      'create a schema': () => box`CREATE SCHEMA box_owned`,
      'read a site': () => box`SELECT * FROM public.sites LIMIT 1`,
      'read the company registry': () => box`SELECT * FROM public.tenant_groups LIMIT 1`,
      'read a company schema': () => box`SELECT * FROM ${box(schema)}."books_asset" LIMIT 1`,
      'read password hashes': () => box`SELECT rolpassword FROM pg_authid`,
      'lift the temporary file limit': () => box`SET temp_file_limit = -1`,
      'become another role': () => box`SET ROLE commerce_app`,
      'end a session of the application': () => box`SELECT pg_terminate_backend(${pid}::int)`,
      'cancel a statement of the application': () => box`SELECT pg_cancel_backend(${pid}::int)`,
      'read a server file': () => box`SELECT pg_read_file('/etc/passwd')`,
    };
    const refused: Record<string, string> = {};
    for (const [name, attempt] of Object.entries(attempts)) refused[name] = await codeOf(attempt);
    // And the application's session is still there.
    expect(await codeOf(() => app`SELECT 1`)).toBe('ok');
    expect(refused).toEqual(Object.fromEntries(Object.keys(refused).map((name) => [name, '42501'])));
    expect(Object.keys(refused)).toHaveLength(20);

    // The four trigger functions PUBLIC may execute cannot be called: 0A000, "trigger functions can
    // only be called as triggers".
    expect(await codeOf(() => box`SELECT public."site_branches_close_without_content"()`)).toBe('0A000');
    expect(await codeOf(() => box`SELECT public."site_branches_site_is_main"()`)).toBe('0A000');
    expect(await codeOf(() => box`SELECT public."site_domains_not_on_branch"()`)).toBe('0A000');
    expect(await codeOf(() => box`SELECT public."sites_branch_parent_guard"()`)).toBe('0A000');
  });

  it('cannot write a temporary file: a sort that does not fit in memory fails, and it cannot change that', async () => {
    const box = as('box_reader');
    expect(((await box`SHOW temp_file_limit`)[0] as { temp_file_limit: string }).temp_file_limit).toBe('0');
    // A million random numbers sorted: far beyond the default working memory, so it needs a file.
    // 53400: temporary file size exceeds temp_file_limit. The statement timeout is lifted for this one
    // statement so that the limit is what stops it.
    const code = await codeOf(() =>
      box.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = 0`;
        await tx`SELECT count(*) FROM (SELECT g FROM generate_series(1, 2000000) g ORDER BY random()) s`;
      }),
    );
    expect(code).toBe('53400');
  }, 60_000);

  it('holds at most four connections', async () => {
    const four = [as('box_reader'), as('box_reader'), as('box_reader'), as('box_reader')];
    for (const sql of four) await sql`SELECT 1`;
    const fifth = as('box_reader');
    // 53300: too many connections for the role.
    expect(await codeOf(() => fifth`SELECT 1`)).toBe('53300');
    await Promise.all(four.map((sql) => sql.end({ timeout: 2 })));
  });
});

describe('what is left, stated in the file and held here as it is', () => {
  it('RESIDUAL: box_reader reads the catalogs (names, never rows)', async () => {
    const box = as('box_reader');
    const names = await box`SELECT relname FROM pg_class WHERE relname IN ('sites', 'tenant_groups') ORDER BY 1`;
    expect(names.map((row) => row.relname)).toEqual(['sites', 'tenant_groups']);
  });

  it('RESIDUAL: box_reader lifts its own timeouts for a session', async () => {
    const box = as('box_reader');
    expect(await codeOf(() => box.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = 0`;
      await tx`SELECT pg_sleep(2.5)`;
    }))).toBe('ok');
  });

  it('RESIDUAL: box_reader changes its own password and its own defaults; re-applying the file puts the defaults back', async () => {
    const box = as('box_reader');
    // A password made of random bytes, set by the role for itself (through psql inside the container,
    // as box_reader: a statement of this kind takes no parameter).
    const own = await container!.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'box_reader', '-d', DB_NAME, '-c', `ALTER ROLE box_reader PASSWORD '${randomBytes(18).toString('hex')}'`]);
    expect(own.exitCode).toBe(0);
    expect(await codeOf(() => box`ALTER ROLE box_reader SET statement_timeout = '1ms'`)).toBe('ok');
    // Also a default the file does not name: only resetting them all puts this one back.
    expect(await codeOf(() => box`ALTER ROLE box_reader SET lock_timeout = '1ms'`)).toBe('ok');
    // It cannot give itself what only a superuser may set.
    expect(await codeOf(() => box`ALTER ROLE box_reader SET temp_file_limit = -1`)).toBe('42501');
    expect(await codeOf(() => box`ALTER ROLE box_reader CONNECTION LIMIT 100`)).toBe('42501');
    expect(await codeOf(() => box`ALTER ROLE box_reader CREATEDB`)).toBe('42501');
    const [changed] = await su!`SELECT rolconfig FROM pg_roles WHERE rolname = 'box_reader'`;
    expect(changed!.rolconfig).toContain('statement_timeout=1ms');
    expect(changed!.rolconfig).toContain('lock_timeout=1ms');
    await apply('box-reader.sql');
    const [restored] = await su!`SELECT rolconfig FROM pg_roles WHERE rolname = 'box_reader'`;
    expect(restored!.rolconfig).toEqual(['statement_timeout=2s', 'idle_in_transaction_session_timeout=5s', 'idle_session_timeout=60s', 'temp_file_limit=0']);
    // The password it set stays until the operator rotates it; the file sets none.
    await su!`ALTER ROLE box_reader PASSWORD NULL`;
  });

  it('RESIDUAL: box_reader ends sessions of its own role (the box\'s own connections), and no other', async () => {
    const victim = as('box_reader');
    const thief = as('box_reader');
    const [{ pid }] = (await victim`SELECT pg_backend_pid() AS pid`) as unknown as [{ pid: number }];
    expect(await codeOf(() => thief`SELECT pg_terminate_backend(${pid}::int)`)).toBe('ok');
    expect(await codeOf(() => victim`SELECT 1`)).not.toBe('ok');
  });

  it('RESIDUAL: box_reader connects to the other databases of the cluster while PUBLIC may', async () => {
    const elsewhere = as('box_reader', 'postgres');
    expect(await codeOf(() => elsewhere`SELECT 1`)).toBe('ok');
    // There it has what PUBLIC has in that database, the application's database not being involved:
    // an advisory lock there is not a lock here.
    expect(await codeOf(() => elsewhere`SELECT pg_advisory_lock(72707369)`)).toBe('ok');
    const here = as('commerce_ddl');
    expect(((await here`SELECT pg_try_advisory_lock(72707369) AS locked`)[0] as { locked: boolean }).locked).toBe(true);
    await here`SELECT pg_advisory_unlock(72707369)`;
    await elsewhere.end({ timeout: 2 });
  });
});

describe('afterwards', () => {
  it('re-applying commerce-roles.sql changes nothing of it', async () => {
    const before = { box: await rightsOf('box_reader'), anyone: await rightsOf('anyone_else'), app: await rightsOf('commerce_app'), ddl: await rightsOf('commerce_ddl') };
    await apply('commerce-roles.sql');
    const after = { box: await rightsOf('box_reader'), anyone: await rightsOf('anyone_else'), app: await rightsOf('commerce_app'), ddl: await rightsOf('commerce_ddl') };
    expect(after).toEqual(before);
    expect(await applicationPaths()).toEqual(ALL_WORK);
  }, 120_000);

  it('the preflight file runs, changes nothing, and reports this database as hardened and clean', async () => {
    const before = await rightsOf('box_reader');
    const output = await apply('box-reader-preflight.sql');
    expect(await rightsOf('box_reader')).toEqual(before);
    // Section 8: no advisory lock function is open to PUBLIC any more.
    expect(output).toMatch(/advisory_lock_functions_open_to_public\s*\n-+\s*\n\s*0\b/);
    // Section 4: no large objects.
    expect(output).toMatch(/large_objects\s*\n-+\s*\n\s*0\b/);
    // Section 2 names the roles this test added, so the operator would see a role the file does not know.
    expect(output).toContain('anyone_else');
  });

  it('the rollback gives PUBLIC its rights back, takes the box\'s login and connection away, and can be run twice', async () => {
    await apply('box-reader-rollback.sql');
    await apply('box-reader-rollback.sql');
    const anyone = await rightsOf('anyone_else');
    expect(anyone.connect).toBe(true);
    expect(anyone.locks.may).toBe(anyone.locks.of);
    // As before the file: everything but lo_import and lo_export, which were never PUBLIC's.
    expect(anyone.largeObjects.may).toBe(anyone.largeObjects.of - 3);
    // TEMPORARY stays as commerce-roles.sql left it.
    expect(anyone.temporary).toBe(false);
    const sql = as('anyone_else');
    expect(await codeOf(() => sql`SELECT pg_advisory_lock(5)`)).toBe('ok');
    const [role] = await su!`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'box_reader'`;
    expect(role!.rolcanlogin).toBe(false);
    const box = as('box_reader');
    expect(await codeOf(() => box`SELECT 1`)).not.toBe('ok');
    expect(await applicationPaths()).toEqual(ALL_WORK);
  }, 120_000);

  it('applying the file again after a rollback closes everything again', async () => {
    await apply('box-reader.sql');
    await su!`ALTER ROLE box_reader LOGIN`;
    const anyone = await rightsOf('anyone_else');
    expect(anyone.connect).toBe(false);
    expect(anyone.locks.may).toBe(0);
    expect(anyone.largeObjects.may).toBe(0);
    const box = await rightsOf('box_reader');
    expect(box.connect).toBe(true);
    expect(box.locks.may).toBe(0);
    expect(await applicationPaths()).toEqual(ALL_WORK);
  }, 120_000);
});

describe('a dump and a restore', () => {
  it('what a restored copy of the database keeps of the rights, and that re-applying the file gives the full shape', async () => {
    await su!`CREATE DATABASE restored_copy`;
    const dump = await container!.exec(['sh', '-c', `pg_dump -U postgres -d ${DB_NAME} | psql -q -U postgres -d restored_copy -v ON_ERROR_STOP=0 >/dev/null 2>&1; echo done`]);
    expect(dump.output).toContain('done');
    const copy = postgres(urlOf('postgres', 'restored_copy'), { max: 1, prepare: false, onnotice: () => {} });
    opened.push(copy);
    const shape = async () => {
      const [connects] = await copy`SELECT has_database_privilege('anyone_else', 'restored_copy', 'CONNECT') AS anyone_connects`;
      const anyone = await mayExecute('anyone_else', copy);
      const app = await mayExecute('commerce_app', copy);
      return { anyone_connects: connects!.anyone_connects as boolean, anyone_locks: anyone.locks.may, app_locks: app.locks.may, lock_functions: anyone.locks.of };
    };
    const restored = await shape();
    // What a plain dump carries is recorded here as it is found, so the operator knows it: the rights
    // on the catalog functions travel with the dump; the right to connect to the database does not
    // (it belongs to the database, which a plain dump of its contents does not create).
    expect(restored.anyone_locks).toBe(0);
    expect(restored.app_locks).toBe(restored.lock_functions);
    expect(restored.anyone_connects).toBe(true);
    // So after any restore the file is applied again, as commerce-roles.sql is, and the shape is whole.
    await apply('box-reader.sql', 'restored_copy');
    const reapplied = await shape();
    expect(reapplied).toEqual({ anyone_connects: false, anyone_locks: 0, app_locks: reapplied.lock_functions, lock_functions: reapplied.lock_functions });
    await copy.end({ timeout: 2 });
  }, 180_000);
});
