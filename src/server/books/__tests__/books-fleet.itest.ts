// src/server/books/__tests__/books-fleet.itest.ts
//
// 007_books reaching schemas that already exist. A tenant group provisioned
// before the Books (at migration 006) gets 007 through the fleet runner
// (`migrateAllCommerceTenants`, what `pnpm db:migrate-tenants` runs as the owner
// role). Afterwards commerce_app must hold exactly the rights it holds on a
// freshly provisioned schema: SELECT and INSERT on the Books tables, UPDATE on
// the editable ones, and no UPDATE / DELETE on the append-only event table.
//
// Two starting points: a schema exactly as the runner provisions it today
// (its default privileges grant new tables to commerce_app), and one whose
// default privileges are gone (a schema provisioned by an older runner, or
// migrated by a role other than the one that provisioned it). The fleet runner
// must not depend on the first.
//
// Own container (the fleet runner sweeps every registered schema), TRUST auth,
// the container superuser as the owner role, no password literals.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { assertTenantGroupId, migratePublic, provisionTenant, tenantSchema } from '@marlinjai/tenant-db';

import { COMMERCE_TENANT_MIGRATIONS } from '../../commerce/migrations/tenant';
import {
  commerceProvisionOptions,
  ensureCommerceTenant,
  migrateAllCommerceTenants,
  readCommerceTenantState,
} from '../../commerce/provisioning/provision';

const DB_NAME = 'books_fleet';
let container: StartedTestContainer | undefined;
let ownerUrl: string;
let owner: postgres.Sql;

const BOOKS_TABLES = [
  'books_company_settings',
  'customer',
  'document_number_counter',
  'document_template',
  'sales_document',
  'sales_document_event',
  'sales_document_line',
];

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_DB: DB_NAME, POSTGRES_HOST_AUTH_METHOD: 'trust' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  ownerUrl = `postgresql://postgres@${container.getHost()}:${container.getMappedPort(5432)}/${DB_NAME}`;
  owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
  await owner`CREATE ROLE commerce_app LOGIN`;
  // The superuser sets the app role's search_path, as prisma/sql/commerce-roles.sql
  // does: provisioning only verifies it (appRoleBootstrap 'verify').
  await owner`ALTER ROLE commerce_app SET search_path = ext`;
  await migratePublic(owner);
  await owner`GRANT USAGE ON SCHEMA ext TO commerce_app`;
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await container?.stop();
});

/** Provision a tenant group with the migration set as it stood before 007_books. */
async function provisionAt006(): Promise<string> {
  return (await provisionAt006WithId()).schema;
}

async function provisionAt006WithId(): Promise<{ tgId: string; schema: string }> {
  const tgId = assertTenantGroupId(randomUUID());
  const before = COMMERCE_TENANT_MIGRATIONS.filter((m) => m.id < '007');
  expect(before.map((m) => m.id).at(-1)).toBe('006_inventory_policy');
  await provisionTenant(owner, {
    ...commerceProvisionOptions(tgId, `fleet-${tgId.slice(0, 8)}`),
    tenantMigrations: before,
  });
  return { tgId, schema: tenantSchema(tgId) };
}

/** commerce_app's rights on every Books table of a schema. */
async function privileges(schema: string) {
  const rows = await owner<{ t: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
    SELECT t,
           has_table_privilege('commerce_app', ${schema} || '.' || t, 'SELECT') AS sel,
           has_table_privilege('commerce_app', ${schema} || '.' || t, 'INSERT') AS ins,
           has_table_privilege('commerce_app', ${schema} || '.' || t, 'UPDATE') AS upd,
           has_table_privilege('commerce_app', ${schema} || '.' || t, 'DELETE') AS del
      FROM unnest(${BOOKS_TABLES}::text[]) AS t
     ORDER BY t
  `;
  return Object.fromEntries(rows.map((r) => [r.t, { sel: r.sel, ins: r.ins, upd: r.upd, del: r.del }]));
}

/** The rights a freshly provisioned schema gives commerce_app (the reference). */
function expectedPrivileges() {
  return Object.fromEntries(
    BOOKS_TABLES.map((t) => [
      t,
      t === 'sales_document_event'
        ? { sel: true, ins: true, upd: false, del: false }
        : t === 'document_number_counter'
          ? { sel: true, ins: true, upd: true, del: false }
          : { sel: true, ins: true, upd: true, del: true },
    ]),
  );
}

async function fleetMigrate(schema: string) {
  const result = await migrateAllCommerceTenants({ connectionString: ownerUrl });
  const mine = result.schemas.find((s) => s.schema === schema);
  expect(mine?.applied).toEqual(['007_books']);
}

describe('007_books through the fleet runner', () => {
  it('a fresh provision is the reference: commerce_app may read and write the Books tables, not rewrite events', async () => {
    const tgId = assertTenantGroupId(randomUUID());
    await provisionTenant(owner, commerceProvisionOptions(tgId, `fresh-${tgId.slice(0, 8)}`));
    expect(await privileges(tenantSchema(tgId))).toEqual(expectedPrivileges());
  });

  it('a schema provisioned at 006 gets the same rights after the fleet migration', async () => {
    const schema = await provisionAt006();
    await fleetMigrate(schema);
    expect(await privileges(schema)).toEqual(expectedPrivileges());
  });

  it('the same holds when the schema has no default privileges for commerce_app', async () => {
    const schema = await provisionAt006();
    await owner`ALTER DEFAULT PRIVILEGES IN SCHEMA ${owner(schema)} REVOKE ALL ON TABLES FROM commerce_app`;
    await owner`ALTER DEFAULT PRIVILEGES IN SCHEMA ${owner(schema)} REVOKE ALL ON SEQUENCES FROM commerce_app`;
    await fleetMigrate(schema);
    expect(await privileges(schema)).toEqual(expectedPrivileges());
  });

  it('commerce_app really can write a Books row and really cannot rewrite an event', async () => {
    const schema = await provisionAt006();
    await fleetMigrate(schema);
    const app = postgres(ownerUrl.replace('postgres@', 'commerce_app@'), { max: 1, prepare: false, onnotice: () => {} });
    try {
      const tenantId = randomUUID();
      const docId = randomUUID();
      await app`INSERT INTO ${app(schema)}.sales_document (id, tenant_id, doc_type, payment_terms_days, updated_at)
                VALUES (${docId}, ${tenantId}, 'invoice', 14, now())`;
      await app`INSERT INTO ${app(schema)}.sales_document_event (id, tenant_id, document_id, event_type)
                VALUES (${randomUUID()}, ${tenantId}, ${docId}, 'draft_created')`;
      const rows = await app`SELECT id FROM ${app(schema)}.sales_document_event WHERE document_id = ${docId}`;
      expect(rows).toHaveLength(1);
      await expect(app`UPDATE ${app(schema)}.sales_document_event SET actor_user_id = 'x' WHERE document_id = ${docId}`).rejects.toMatchObject({ code: '42501' });
      await expect(app`DELETE FROM ${app(schema)}.sales_document_event WHERE document_id = ${docId}`).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
  });

  it('a company at 006 is not "ready": the fleet path brings it to 007 and then it is', async () => {
    const { tgId, schema } = await provisionAt006WithId();
    expect(await readCommerceTenantState(owner, tgId, schema)).toBe('missing');
    await fleetMigrate(schema);
    expect(await readCommerceTenantState(owner, tgId, schema)).toBe('ready');
  });

  it('ensureCommerceTenant on a company at 006 applies 007 with the fresh rights, then takes the fast path', async () => {
    const { tgId, schema } = await provisionAt006WithId();
    const first = await ensureCommerceTenant({ tenantGroupId: tgId, slug: `fleet-${tgId.slice(0, 8)}`, connectionString: ownerUrl });
    expect(first.provisioned).toBe(true);
    expect(first.applied).toEqual(['007_books']);
    expect(await privileges(schema)).toEqual(expectedPrivileges());
    expect(await readCommerceTenantState(owner, tgId, schema)).toBe('ready');
    const second = await ensureCommerceTenant({ tenantGroupId: tgId, slug: `fleet-${tgId.slice(0, 8)}`, connectionString: ownerUrl });
    expect(second).toMatchObject({ provisioned: false, applied: [] });
  });
});
