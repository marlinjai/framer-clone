// src/server/commerce/provisioning/__tests__/provision.itest.ts
//
// Integration test (Dockerized Postgres) for the CM-11 commerce PER-TENANT
// provisioning + FLEET migration tier. It proves that:
//
//   1. `provisionCommerceTenant({ tenantGroupId, slug })` — on a public tier
//      stood up by `migrateCommercePublic` — creates an ACTIVE `tg_<id>` row in
//      `public.tenant_groups` (status='active') with the per-tenant commerce
//      tables present AND the `commerce_app` grants (USAGE on the schema +
//      table privileges) in force, driven by the runner's `provisionTenant`
//      with `appRole: 'commerce_app'`.
//   2. A second provision of the same tenant-group is a clean idempotent no-op
//      (applied === []), the registry row stays active, and the schema is intact.
//   3. `migrateAllCommerceTenants` over a fleet of >= 2 provisioned tenant-groups
//      processes every schema cleanly and is RESUMABLE: a re-run applies nothing
//      new.
//
// TRUST AUTH (per the spec): the container runs with
// POSTGRES_HOST_AUTH_METHOD=trust and we connect with USERNAME-ONLY URIs
// (`postgresql://postgres@host:port/db`) — NO password literals, which would
// trip GitGuardian and block the PR. The container superuser `postgres` is the
// DDL OWNER, exactly the role COMMERCE_OWNER_DATABASE_URL (`commerce_ddl`) plays
// in a real deploy. We CREATE the low-privilege `commerce_app` role up front so
// the runner's grants + `ext`-locked role default have a real grantee.
//
// The `.itest.ts` suffix keeps this OUT of the headless `pnpm test` unit run
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs ONLY under
// `pnpm test:integration` against Docker. Mirrors public.itest.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { migrateCommercePublic } from '../public';
import { provisionCommerceTenant, migrateAllCommerceTenants } from '../provision';

const DB_NAME = 'framer_clone_test';

let container: StartedTestContainer | undefined;
let ownerUrl: string | undefined;
// A direct probe client (the container superuser) used only to assert the
// resulting schema — NOT the handle under test.
let probe: postgres.Sql | undefined;

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      // TRUST auth: no password anywhere (no GitGuardian-tripping literals).
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: DB_NAME,
      POSTGRES_HOST_AUTH_METHOD: 'trust',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  // USERNAME-ONLY URI under trust auth — the container superuser is the DDL
  // owner, exactly the role COMMERCE_OWNER_DATABASE_URL (`commerce_ddl`) plays.
  ownerUrl = `postgresql://postgres@${host}:${port}/${DB_NAME}`;
  probe = postgres(ownerUrl, { max: 1, prepare: false });

  // The runner grants per-schema USAGE + table privileges to `commerce_app` and
  // locks its default search_path to `ext`. That role must exist first.
  await probe`CREATE ROLE commerce_app NOLOGIN`;

  // Stand up the public tier (ext schema + the tenant_groups registry) the
  // per-tenant provisioning builds on.
  await migrateCommercePublic(ownerUrl);
}, 180_000);

afterAll(async () => {
  await probe?.end();
  await container?.stop();
});

describe('CM-11 commerce per-tenant provisioning (provisionCommerceTenant → provisionTenant)', () => {
  it('throws a clear OWNER-role error when no owner connection string is available', async () => {
    const saved = process.env.COMMERCE_OWNER_DATABASE_URL;
    delete process.env.COMMERCE_OWNER_DATABASE_URL;
    try {
      await expect(
        provisionCommerceTenant({ tenantGroupId: randomUUID(), slug: 'acme' }),
      ).rejects.toThrow(/COMMERCE_OWNER_DATABASE_URL/);
      await expect(
        provisionCommerceTenant({ tenantGroupId: randomUUID(), slug: 'acme' }),
      ).rejects.toThrow(/OWNER role/);
    } finally {
      if (saved !== undefined) process.env.COMMERCE_OWNER_DATABASE_URL = saved;
    }
  });

  it('provisions an ACTIVE tg_<id> schema with commerce tables + commerce_app grants', async () => {
    const tenantGroupId = randomUUID();
    const { schema, applied } = await provisionCommerceTenant({
      tenantGroupId,
      slug: 'acme-commerce',
      connectionString: ownerUrl,
    });

    // The derived schema name is `tg_` + the uuid with hyphens stripped.
    expect(schema).toBe(`tg_${tenantGroupId.replace(/-/g, '')}`);
    // First provision applies the full CM-04 tenant migration set, in order.
    expect(applied).toEqual([
      '000_enums',
      '001_inventory_ledger',
      '002_guarded_reservation',
      '003_catalog',
      '004_pricing_and_tax',
      '005_minimal_orders',
      '006_inventory_policy',
    ]);

    // The registry row exists and is ACTIVE (the runner flips status only after
    // migrations verify).
    const reg = await probe!`
      SELECT slug, schema_name, status
      FROM public.tenant_groups
      WHERE id = ${tenantGroupId}
    `;
    expect(reg.length).toBe(1);
    expect(reg[0].schema_name).toBe(schema);
    expect(reg[0].status).toBe('active');
    expect(reg[0].slug).toBe('acme-commerce');

    // Representative per-tenant commerce tables landed in the tg_<id> schema.
    const tables = await probe!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema}
        AND table_name IN ('product', 'inventory_item', 'order', 'price')
      ORDER BY table_name
    `;
    expect(tables.map((r) => r.table_name)).toEqual([
      'inventory_item',
      'order',
      'price',
      'product',
    ]);

    // The commerce_app grants are in force: USAGE on the schema and at least
    // SELECT on a table within it.
    const grants = await probe!`
      SELECT
        has_schema_privilege('commerce_app', ${schema}, 'USAGE') AS schema_usage,
        has_table_privilege('commerce_app', ${schema + '.product'}, 'SELECT') AS table_select
    `;
    expect(grants[0].schema_usage).toBe(true);
    expect(grants[0].table_select).toBe(true);
  });

  it('is idempotent: re-provisioning the same tenant-group applies nothing new', async () => {
    const tenantGroupId = randomUUID();
    const first = await provisionCommerceTenant({
      tenantGroupId,
      slug: 'idem-co',
      connectionString: ownerUrl,
    });
    expect(first.applied.length).toBeGreaterThan(0);

    const second = await provisionCommerceTenant({
      tenantGroupId,
      slug: 'idem-co',
      connectionString: ownerUrl,
    });
    // A re-provision is a clean no-op: same schema, nothing newly applied.
    expect(second.schema).toBe(first.schema);
    expect(second.applied).toEqual([]);

    // The row is still active and the schema intact.
    const reg = await probe!`
      SELECT status FROM public.tenant_groups WHERE id = ${tenantGroupId}
    `;
    expect(reg[0].status).toBe('active');
  });
});

describe('CM-11 commerce fleet migration (migrateAllCommerceTenants → migrateAllTenants)', () => {
  it('processes a fleet of >= 2 tenant-groups cleanly and is resumable (re-run applies nothing)', async () => {
    // Provision two MORE tenant-groups so the fleet has >= 2 (plus any from the
    // provisioning describe above, which share this container).
    await provisionCommerceTenant({
      tenantGroupId: randomUUID(),
      slug: 'fleet-one',
      connectionString: ownerUrl,
    });
    await provisionCommerceTenant({
      tenantGroupId: randomUUID(),
      slug: 'fleet-two',
      connectionString: ownerUrl,
    });

    const registryCount = await probe!`SELECT count(*)::int AS n FROM public.tenant_groups`;
    expect(registryCount[0].n).toBeGreaterThanOrEqual(2);

    // First fleet sweep: every schema is already at head (provisioning applied
    // the full set), so it processes all and applies nothing new.
    const first = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(first.total).toBe(registryCount[0].n);
    expect(first.processed).toBe(first.total);
    expect(first.schemas.length).toBe(first.total);
    for (const s of first.schemas) {
      expect(s.applied).toEqual([]);
    }

    // Resumable / idempotent: a re-run applies nothing new again.
    const second = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(second.processed).toBe(second.total);
    for (const s of second.schemas) {
      expect(s.applied).toEqual([]);
    }
  });
});
