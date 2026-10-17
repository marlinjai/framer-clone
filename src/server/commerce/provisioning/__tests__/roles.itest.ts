// src/server/commerce/provisioning/__tests__/roles.itest.ts
//
// Integration test (Dockerized Postgres 16) for prisma/sql/commerce-roles.sql
// and the container start step, in the production role topology. Every other
// commerce itest runs the owner as the container SUPERUSER; this one is the
// only proof that a NON-superuser commerce_ddl can do the owner's whole job.
//
// It replays the deploy order on a fresh database:
//   1. the roles file, applied twice (idempotent), as the superuser, then
//      `ALTER ROLE ... LOGIN` for both roles (what 07-commerce-roles.sh does,
//      minus the password: the container uses TRUST auth, so the URIs are
//      username-only and no password literal exists anywhere);
//   2. `prisma migrate deploy` as the superuser (the Prisma tier, DATABASE_URL);
//   3. the container start step (runCommerceDeployMigrations) as commerce_ddl:
//      public migrations on an empty fleet;
//   4. a company's first project: provisionCommerceTenant as commerce_ddl;
//   5. the start step again: the fleet migration sees the schema, applies
//      nothing, and re-asserts the append-only REVOKEs;
//   6. as commerce_app: the backstop holds, a catalog is seeded, an order is
//      placed, and the placed order and its lines cannot be changed or deleted;
//   7. the roles file once more on the migrated database: nothing changes.
// It also pins the privilege shape: commerce_ddl is not a superuser and cannot
// alter other roles; commerce_app cannot create anything and has search_path ext.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import { assertBackstop, tenantDb } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../../db-types';
import { createOrder } from '../../order/createOrder';
import { APPEND_ONLY_TABLES, provisionCommerceTenant } from '../provision';
import { runCommerceDeployMigrations } from '../deploy';

const DB_NAME = 'framer_clone_roles_test';
const ROLES_SQL_PATH = path.resolve(__dirname, '../../../../../prisma/sql/commerce-roles.sql');
const ROLES_SQL_IN_CONTAINER = '/tmp/commerce-roles.sql';

let container: StartedTestContainer | undefined;
let superUrl: string;
let ownerUrl: string;
let appUrl: string;
let su: postgres.Sql | undefined;
let appBase: Kysely<CommerceDB> | undefined;

const url = (user: string, host: string, port: number) =>
  `postgresql://${user}@${host}:${port}/${DB_NAME}`;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: DB_NAME,
      POSTGRES_HOST_AUTH_METHOD: 'trust',
    })
    .withExposedPorts(5432)
    .withCopyFilesToContainer([{ source: ROLES_SQL_PATH, target: ROLES_SQL_IN_CONTAINER }])
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = url('postgres', host, port);
  ownerUrl = url('commerce_ddl', host, port);
  appUrl = url('commerce_app', host, port);
  su = postgres(superUrl, { max: 1, prepare: false, onnotice: () => {} });
  // Simulate a database from an older dump: PUBLIC (every role, commerce_app
  // included) may create in `public`, as Postgres 14 and earlier allowed. TEMP
  // on the database is a Postgres default for PUBLIC anyway. The roles file
  // must take both away.
  await su`GRANT CREATE ON SCHEMA public TO PUBLIC`;
}, 180_000);

/** Apply the roles file the way the deploy does: psql, stop on the first error. */
async function applyRolesFile(): Promise<void> {
  const { exitCode, output } = await container!.exec([
    'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres', '-d', DB_NAME, '-f', ROLES_SQL_IN_CONTAINER,
  ]);
  if (exitCode !== 0) throw new Error(`commerce-roles.sql failed (exit ${exitCode}): ${output}`);
}

afterAll(async () => {
  await appBase?.destroy();
  await su?.end();
  await container?.stop();
});

describe('commerce-roles.sql on a fresh Postgres 16, owner as a non-superuser', () => {
  it('applies cleanly, twice, and the roles can then be given a login', async () => {
    await applyRolesFile();
    await applyRolesFile();
    // 07-commerce-roles.sh grants LOGIN with a password; under TRUST auth the
    // LOGIN attribute alone is enough to connect.
    await su!`ALTER ROLE commerce_app LOGIN`;
    await su!`ALTER ROLE commerce_ddl LOGIN`;
    // A re-run after the login was granted must not take it away again.
    await applyRolesFile();

    const roles = await su!<
      { rolname: string; rolsuper: boolean; rolcanlogin: boolean; rolcreaterole: boolean; rolcreatedb: boolean }[]
    >`
      SELECT rolname, rolsuper, rolcanlogin, rolcreaterole, rolcreatedb
      FROM pg_roles WHERE rolname IN ('commerce_app', 'commerce_ddl') ORDER BY rolname
    `;
    expect(roles).toEqual([
      { rolname: 'commerce_app', rolsuper: false, rolcanlogin: true, rolcreaterole: false, rolcreatedb: false },
      { rolname: 'commerce_ddl', rolsuper: false, rolcanlogin: true, rolcreaterole: true, rolcreatedb: false },
    ]);
  });

  it('runs the Prisma tier first, as the database superuser (DATABASE_URL)', () => {
    execSync('pnpm exec prisma migrate deploy', {
      stdio: 'ignore',
      env: { ...process.env, DATABASE_URL: superUrl },
    });
  }, 120_000);

  it('pins the privilege shape of both roles', async () => {
    const [p] = await su!`
      SELECT
        has_database_privilege('commerce_ddl', current_database(), 'CREATE') AS ddl_db_create,
        has_database_privilege('commerce_app', current_database(), 'CREATE') AS app_db_create,
        has_schema_privilege('commerce_ddl', 'public', 'CREATE') AS ddl_public_create,
        has_schema_privilege('commerce_app', 'public', 'CREATE') AS app_public_create,
        has_schema_privilege('commerce_app', 'ext', 'USAGE') AS app_ext_usage,
        has_schema_privilege('commerce_app', 'ext', 'CREATE') AS app_ext_create,
        has_database_privilege('commerce_app', current_database(), 'TEMP') AS app_temp,
        has_database_privilege('commerce_ddl', current_database(), 'TEMP') AS ddl_temp,
        (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'ext') AS ext_owner,
        (SELECT rolconfig FROM pg_roles WHERE rolname = 'commerce_app') AS app_config,
        pg_has_role('commerce_ddl', 'commerce_app', 'USAGE') AS ddl_inherits_app,
        pg_has_role('commerce_ddl', 'commerce_app', 'SET') AS ddl_can_set_app
    `;
    expect(p).toEqual({
      ddl_db_create: true,
      app_db_create: false,
      ddl_public_create: true,
      app_public_create: false,
      app_ext_usage: true,
      app_ext_create: false,
      app_temp: false,
      ddl_temp: false,
      ext_owner: 'commerce_ddl',
      app_config: ['search_path=ext'],
      ddl_inherits_app: false,
      ddl_can_set_app: false,
    });

    // And in practice: commerce_app can create neither a table in `public` nor a
    // temporary table.
    const app = postgres(appUrl, { max: 1, prepare: false });
    try {
      await expect(app`CREATE TABLE public.decoy (id int)`).rejects.toThrow(/permission denied/);
      await expect(app`CREATE TEMP TABLE scratch (id int)`).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }

    // CREATEROLE on Postgres 16 reaches only roles commerce_ddl administers.
    const ddl = postgres(ownerUrl, { max: 1, prepare: false });
    try {
      await expect(ddl`ALTER ROLE postgres SET search_path = ext`).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await ddl.end();
    }
  });

  it('refuses to run the start step as the app role', async () => {
    await expect(
      runCommerceDeployMigrations({ ownerUrl: appUrl, appUrl: 'postgresql://other', log: () => {} }),
    ).rejects.toThrow(/authenticates as commerce_app/);
  });

  it('start step as commerce_ddl: public tier on an empty fleet', async () => {
    const lines: string[] = [];
    const result = await runCommerceDeployMigrations({ ownerUrl, appUrl, log: (l) => lines.push(l) });
    expect(result.role).toBe('commerce_ddl');
    expect(result.publicApplied).toEqual(['001_ext_schema', '002_tenant_groups']);
    expect(result.tenantSchemas).toBe(0);
    expect(lines[0]).toBe('commerce: migrating as commerce_ddl');

    const [owners] = await su!`
      SELECT
        (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenant_groups') AS registry_owner,
        (SELECT extname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE n.nspname = 'ext' AND extname = 'pgcrypto') AS pgcrypto
    `;
    expect(owners).toEqual({ registry_owner: 'commerce_ddl', pgcrypto: 'pgcrypto' });
  });

  let tgId: string;
  let schema: string;

  it('provisions a company schema as commerce_ddl (what the first project does)', async () => {
    tgId = randomUUID();
    const provisioned = await provisionCommerceTenant({
      tenantGroupId: tgId,
      slug: 'roles-itest',
      connectionString: ownerUrl,
    });
    schema = provisioned.schema;
    expect(provisioned.applied.length).toBeGreaterThan(0);

    const [s] = await su!`
      SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = ${schema}
    `;
    expect(s.owner).toBe('commerce_ddl');
  });

  it('start step again: the fleet migration sees the schema and applies nothing', async () => {
    const result = await runCommerceDeployMigrations({ ownerUrl, appUrl, log: () => {} });
    expect(result.publicApplied).toEqual([]);
    expect(result.tenantSchemas).toBe(1);
    expect(result.tenantApplied).toEqual([{ schema, applied: [] }]);
  });

  it('as commerce_app: backstop holds, an order is placed, and it stays append-only', async () => {
    appBase = createNodeDb<CommerceDB>({ connectionString: appUrl });
    await assertBackstop(appBase);
    const db = tenantDb(appBase, tgId);
    const now = new Date();

    // Seed a priced, stocked variant through the app role (catalog and stock
    // tables are ordinary DML for it).
    const productId = randomUUID();
    await db.insertInto('product').values({ id: productId, title: 'P', handle: `p-${productId}`, updated_at: now }).execute();
    const variantId = randomUUID();
    await db
      .insertInto('product_variant')
      .values({ id: variantId, product_id: productId, title: 'V', sku: `SKU-${variantId}`, updated_at: now })
      .execute();
    const priceSetId = randomUUID();
    await db.insertInto('price_set').values({ id: priceSetId, variant_id: variantId, updated_at: now }).execute();
    await db
      .insertInto('price')
      .values({ id: randomUUID(), price_set_id: priceSetId, currency_code: 'EUR', amount: 1500, updated_at: now })
      .execute();
    const itemId = randomUUID();
    await db.insertInto('inventory_item').values({ id: itemId, sku: `INV-${itemId}`, updated_at: now }).execute();
    const locationId = randomUUID();
    await db.insertInto('stock_location').values({ id: locationId, name: `WH-${locationId}`, updated_at: now }).execute();
    await db
      .insertInto('inventory_level')
      .values({
        id: randomUUID(),
        inventory_item_id: itemId,
        location_id: locationId,
        stocked_quantity: 5,
        reserved_quantity: 0,
        updated_at: now,
      })
      .execute();

    const result = await createOrder(db, tgId, {
      requestId: `roles-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [{ inventoryItemId: itemId, variantId, quantity: 2, locationId }],
    });
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    const order = await db.selectFrom('order').selectAll().where('id', '=', result.orderId).executeTakeFirstOrThrow();
    expect(order.total).toBe(3570); // 3000 + 19%

    await expect(
      db.updateTable('order').set({ status: 'cancelled' }).where('id', '=', result.orderId).execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(db.deleteFrom('order').where('id', '=', result.orderId).execute()).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.updateTable('order_line_item').set({ quantity: 99 }).where('order_id', '=', result.orderId).execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.deleteFrom('stock_movement').where('inventory_item_id', '=', itemId).execute(),
    ).rejects.toThrow(/permission denied/);

    for (const table of APPEND_ONLY_TABLES) {
      const qualified = `${schema}."${table}"`;
      const [row] = await su!`
        SELECT
          has_table_privilege('commerce_app', ${qualified}, 'INSERT') AS can_insert,
          has_table_privilege('commerce_app', ${qualified}, 'SELECT') AS can_select,
          has_table_privilege('commerce_app', ${qualified}, 'UPDATE') AS can_update,
          has_table_privilege('commerce_app', ${qualified}, 'DELETE') AS can_delete
      `;
      expect({ table, ...row }).toEqual({
        table,
        can_insert: true,
        can_select: true,
        can_update: false,
        can_delete: false,
      });
    }

    // commerce_app runs no DDL in the company schema.
    const app = postgres(appUrl, { max: 1, prepare: false });
    try {
      await expect(app`CREATE TABLE ${app(schema)}.intruder (id int)`).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
  it('re-applying the file on a migrated, provisioned database changes nothing', async () => {
    await applyRolesFile();

    const [p] = await su!`
      SELECT
        (SELECT rolconfig FROM pg_roles WHERE rolname = 'commerce_app') AS app_config,
        (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'commerce_ddl') AS ddl_login,
        (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'ext') AS ext_owner,
        (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = ${schema}) AS schema_owner,
        has_table_privilege('commerce_app', ${schema + '."order"'}, 'UPDATE') AS app_order_update,
        has_table_privilege('commerce_app', ${schema + '."order"'}, 'INSERT') AS app_order_insert
    `;
    expect(p).toEqual({
      app_config: ['search_path=ext'],
      ddl_login: true,
      ext_owner: 'commerce_ddl',
      schema_owner: 'commerce_ddl',
      app_order_update: false,
      app_order_insert: true,
    });

    // The start step still runs cleanly afterwards.
    const result = await runCommerceDeployMigrations({ ownerUrl, appUrl, log: () => {} });
    expect(result.tenantApplied).toEqual([{ schema, applied: [] }]);
  });
});
