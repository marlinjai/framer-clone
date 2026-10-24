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
import { templateProblems } from '../template/gate';
import { parseTemplateDocument } from '../template/schema';
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
  'books_asset',
  'books_company_settings',
  'books_product',
  'customer',
  'document_number_counter',
  'document_template',
  'document_template_version',
  'sales_document',
  'sales_document_event',
  'sales_document_file',
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

/** commerce_app's rights on every Books table of a schema (the tables it has: a schema at an older migration lacks the later ones). */
async function privileges(schema: string) {
  const rows = await owner<{ t: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
    SELECT t,
           has_table_privilege('commerce_app', ${schema} || '.' || t, 'SELECT') AS sel,
           has_table_privilege('commerce_app', ${schema} || '.' || t, 'INSERT') AS ins,
           has_table_privilege('commerce_app', ${schema} || '.' || t, 'UPDATE') AS upd,
           has_table_privilege('commerce_app', ${schema} || '.' || t, 'DELETE') AS del
      FROM unnest(${BOOKS_TABLES}::text[]) AS t
     WHERE to_regclass(quote_ident(${schema}) || '.' || quote_ident(t)) IS NOT NULL
     ORDER BY t
  `;
  return Object.fromEntries(rows.map((r) => [r.t, { sel: r.sel, ins: r.ins, upd: r.upd, del: r.del }]));
}

/** The rights a freshly provisioned schema gives commerce_app (the reference). */
function expectedPrivileges() {
  return Object.fromEntries(
    BOOKS_TABLES.map((t) => [
      t,
      t === 'sales_document_event' || t === 'sales_document_file' || t === 'document_template_version'
        ? { sel: true, ins: true, upd: false, del: false }
        : t === 'document_number_counter'
          ? { sel: true, ins: true, upd: true, del: false }
          : t === 'books_asset'
            ? { sel: true, ins: true, upd: false, del: true }
            : { sel: true, ins: true, upd: true, del: true },
    ]),
  );
}

async function fleetMigrate(schema: string) {
  const result = await migrateAllCommerceTenants({ connectionString: ownerUrl });
  const mine = result.schemas.find((s) => s.schema === schema);
  expect(mine?.applied).toEqual([
    '007_books',
    '008_books_files',
    '009_books_import',
    '010_books_upload_import',
    '011_books_replacement',
    '012_books_template_v2',
    '013_books_assets',
    '014_books_asset_delete',
    '015_books_products',
    '016_books_subject',
  ]);
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
    expect(first.applied).toEqual([
      '007_books',
      '008_books_files',
      '009_books_import',
      '010_books_upload_import',
      '011_books_replacement',
      '012_books_template_v2',
      '013_books_assets',
      '014_books_asset_delete',
      '015_books_products',
      '016_books_subject',
    ]);
    expect(await privileges(schema)).toEqual(expectedPrivileges());
    expect(await readCommerceTenantState(owner, tgId, schema)).toBe('ready');
    const second = await ensureCommerceTenant({ tenantGroupId: tgId, slug: `fleet-${tgId.slice(0, 8)}`, connectionString: ownerUrl });
    expect(second).toMatchObject({ provisioned: false, applied: [] });
  });
});

describe('009_books_import over a schema already holding issued documents (as production at 008)', () => {
  it('leaves the documents and lines as they are, and every guarantee they had still holds', async () => {
    const tgId = assertTenantGroupId(randomUUID());
    const schema = tenantSchema(tgId);
    await provisionTenant(owner, {
      ...commerceProvisionOptions(tgId, `at008-${tgId.slice(0, 8)}`),
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS.filter((m) => m.id < '009'),
    });
    const s = owner(schema);
    const tenantId = randomUUID();
    const customerId = randomUUID();
    const docId = randomUUID();
    await owner`INSERT INTO ${s}.customer (id, tenant_id, contact_id, updated_at) VALUES (${customerId}, ${tenantId}, ${randomUUID()}, now())`;
    await owner`INSERT INTO ${s}.sales_document (id, tenant_id, doc_type, payment_terms_days, customer_id, updated_at)
                VALUES (${docId}, ${tenantId}, 'invoice', 14, ${customerId}, now())`;
    await owner`INSERT INTO ${s}.sales_document_line (id, tenant_id, document_id, position, title, quantity, unit_price, subtotal, tax_rate, tax_amount, tax_treatment, updated_at)
                VALUES (${randomUUID()}, ${tenantId}, ${docId}, 1, 'Synthetic line', 1000, 5000, 5000, 0, 0, 'kleinunternehmer', now())`;
    await owner`UPDATE ${s}.sales_document
                   SET status = 'issued', document_number = '62', number_value = 62, issue_date = '2026-10-01', issued_at = now(),
                       customer_type = 'b2c', tax_profile_key = 'small_business|b2c||DE', subtotal = 5000, total = 5000,
                       customer_snapshot = '{"v":1}'::jsonb, sender_snapshot = '{"v":1}'::jsonb, template_snapshot = '{"v":1}'::jsonb
                 WHERE id = ${docId}`;
    const snapshot = async () =>
      // 011 adds the nullable column replaces_document_id, 012 the column
      // print_replaces_reference and 016 the nullable subject: compared
      // without them (they did not exist before), and asserted NULL, false
      // and NULL below.
      owner`SELECT to_jsonb(d) - 'replaces_document_id' - 'print_replaces_reference' - 'subject' AS doc, (SELECT jsonb_agg(to_jsonb(l)) FROM ${s}.sales_document_line l WHERE l.document_id = d.id) AS lines
              FROM ${s}.sales_document d WHERE d.id = ${docId}`;
    const before = await snapshot();

    const result = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(result.schemas.find((x) => x.schema === schema)?.applied).toEqual([
      '009_books_import',
      '010_books_upload_import',
      '011_books_replacement',
      '012_books_template_v2',
      '013_books_assets',
      '014_books_asset_delete',
      '015_books_products',
      '016_books_subject',
    ]);

    expect(await snapshot()).toEqual(before);
    const [link] = await owner<{ replaces_document_id: string | null; print_replaces_reference: boolean; subject: string | null }[]>`
      SELECT replaces_document_id, print_replaces_reference, subject FROM ${s}.sales_document WHERE id = ${docId}`;
    expect(link).toEqual({ replaces_document_id: null, print_replaces_reference: false, subject: null });
    const [fk] = await owner<{ condeferrable: boolean; condeferred: boolean }[]>`
      SELECT c.condeferrable, c.condeferred FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = ${schema} AND c.conname = 'sales_document_line_document_fkey'`;
    // Deferrable on request only: every writer that does not ask is checked per statement, as before.
    expect(fk).toEqual({ condeferrable: true, condeferred: false });
    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    // A line into the issued document: still frozen.
    expect(
      await code(owner`INSERT INTO ${s}.sales_document_line (id, tenant_id, document_id, position, title, quantity, unit_price, subtotal, tax_rate, tax_amount, tax_treatment, updated_at)
                       VALUES (${randomUUID()}, ${tenantId}, ${docId}, 2, 'Late line', 1000, 1, 1, 0, 0, 'kleinunternehmer', now())`),
    ).toBe('BK001');
    // A line without its document, not deferred: refused at once, as before 009.
    expect(
      await code(owner`INSERT INTO ${s}.sales_document_line (id, tenant_id, document_id, position, title, quantity, unit_price, subtotal, tax_rate, tax_amount, tax_treatment, updated_at)
                       VALUES (${randomUUID()}, ${tenantId}, ${randomUUID()}, 1, 'Orphan line', 1000, 1, 1, 0, 0, 'kleinunternehmer', now())`),
    ).toBe('23503');
    // A negative line on an editor draft: refused by the guard that replaced 007's CHECKs.
    const draftId = randomUUID();
    await owner`INSERT INTO ${s}.sales_document (id, tenant_id, doc_type, payment_terms_days, updated_at) VALUES (${draftId}, ${tenantId}, 'invoice', 14, now())`;
    expect(
      await code(owner`INSERT INTO ${s}.sales_document_line (id, tenant_id, document_id, position, title, quantity, unit_price, subtotal, tax_rate, tax_amount, tax_treatment, updated_at)
                       VALUES (${randomUUID()}, ${tenantId}, ${draftId}, 1, 'Negative line', 1000, -1, -1, 0, 0, 'kleinunternehmer', now())`),
    ).toBe('BK008');
    // A currency other than EUR on an editor draft: refused by the guard that replaced the EUR CHECK.
    expect(await code(owner`UPDATE ${s}.sales_document SET currency_code = 'CHF' WHERE id = ${draftId}`)).toBe('BK009');
    // The issued document itself: still frozen.
    expect(await code(owner`UPDATE ${s}.sales_document SET total = 1, subtotal = 1 WHERE id = ${docId}`)).toBe('BK001');
  });
});

describe('012_books_template_v2 through the fleet runner', () => {
  it('converts every existing template into its version 1, drops the old columns, and keeps versions append-only', async () => {
    const tgId = assertTenantGroupId(randomUUID());
    await provisionTenant(owner, {
      ...commerceProvisionOptions(tgId, `tpl-${tgId.slice(0, 8)}`),
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS.filter((m) => m.id < '012'),
    });
    const schema = tenantSchema(tgId);
    const s = owner(schema);
    const tenantId = randomUUID();
    const withAccent = randomUUID();
    const plain = randomUUID();
    await owner`INSERT INTO ${s}.document_template (id, tenant_id, name, is_default, accent_color, footer_blocks, updated_at)
                VALUES (${withAccent}, ${tenantId}, 'Standard', true, '#2b4c7e',
                        ${owner.json([{ heading: 'Hinweis', text: 'Synthetic small print A.' }, { text: 'Synthetic small print B.' }])}, now())`;
    await owner`INSERT INTO ${s}.document_template (id, tenant_id, name, accent_color, footer_blocks, updated_at)
                VALUES (${plain}, ${tenantId}, 'Plain', NULL, ${owner.json([{ unexpected: 1 }])}, now())`;

    const result = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(result.schemas.find((x) => x.schema === schema)?.applied).toEqual(['012_books_template_v2', '013_books_assets', '014_books_asset_delete', '015_books_products', '016_books_subject']);

    const columns = await owner<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = 'document_template' ORDER BY column_name`;
    for (const gone of ['accent_color', 'footer_blocks', 'logo_file_id']) expect(columns.map((c) => c.column_name)).not.toContain(gone);

    const rows = await owner<{ id: string; version: number; document: unknown; current: string; vid: string }[]>`
      SELECT t.id, v.version, v.document, t.current_version_id AS current, v.id AS vid
        FROM ${s}.document_template t JOIN ${s}.document_template_version v ON v.template_id = t.id
       WHERE t.tenant_id = ${tenantId} ORDER BY t.name`;
    expect(rows.map((r) => [r.version, r.current === r.vid])).toEqual([
      [1, true],
      [1, true],
    ]);
    const byId = new Map(rows.map((r) => [r.id, parseTemplateDocument(r.document)]));
    const standard = byId.get(withAccent)!;
    const plainDoc = byId.get(plain)!;
    expect(standard.theme.accent).toBe('#2b4c7e');
    expect(plainDoc.theme.accent).toBe('#333340');
    expect(standard.regions.body.filter((b) => b.type === 'freeText').map((b) => b.type === 'freeText' && [b.heading, b.text, b.variant])).toEqual([
      ['Hinweis', 'Synthetic small print A.', 'smallPrint'],
      [null, 'Synthetic small print B.', 'smallPrint'],
    ]);
    expect(plainDoc.regions.body.some((b) => b.type === 'freeText')).toBe(false);
    // The converted layouts are valid templates: the whole save gate passes on them.
    expect(await templateProblems(standard)).toEqual([]);
    expect(await templateProblems(plainDoc)).toEqual([]);

    // Versions are append-only for every role.
    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    expect(await code(owner`UPDATE ${s}.document_template_version SET version = 7 WHERE template_id = ${withAccent}`)).toBe('BK012');
    expect(await code(owner`DELETE FROM ${s}.document_template_version WHERE template_id = ${withAccent}`)).toBe('BK012');
    // A plain TRUNCATE is refused by the template table's key (0A000); with CASCADE it reaches the guard.
    expect(await code(owner`TRUNCATE ${s}.document_template_version`)).toBe('0A000');
    expect(await code(owner`TRUNCATE ${s}.document_template_version CASCADE`)).toBe('BK012');
    const app = postgres(ownerUrl.replace('postgres@', 'commerce_app@'), { max: 1, prepare: false, onnotice: () => {} });
    try {
      expect(await code(app`UPDATE ${app(schema)}.document_template_version SET version = 7 WHERE template_id = ${withAccent}`)).toBe('42501');
      expect(await code(app`DELETE FROM ${app(schema)}.document_template_version WHERE template_id = ${withAccent}`)).toBe('42501');
      // The current version must be one of the template's own (checked at commit, the key is deferred).
      const other = rows.find((r) => r.id === plain)!.vid;
      expect(await code(app.begin((tx) => tx`UPDATE ${tx(schema)}.document_template SET current_version_id = ${other} WHERE id = ${withAccent}`))).toBe('23503');
      // A version document must be a version 2 object.
      expect(
        await code(app`INSERT INTO ${app(schema)}.document_template_version (id, tenant_id, template_id, version, document)
                       VALUES (${randomUUID()}, ${tenantId}, ${withAccent}, 2, ${app.json({ v: 1 })})`),
      ).toBe('23514');
    } finally {
      await app.end();
    }
    expect(await privileges(schema)).toEqual(expectedPrivileges());

    // Running 012 a second time (the runner forgets it applied it) changes nothing and does not fail.
    const versionsBefore = await owner`SELECT id FROM ${s}.document_template_version ORDER BY id`;
    await owner`DELETE FROM ${s}.__tenant_db_migrations WHERE id = '012_books_template_v2'`;
    await owner`DELETE FROM public.tenant_migration_progress WHERE schema_name = ${schema} AND migration_id = '012_books_template_v2'`;
    const again = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(again.schemas.find((x) => x.schema === schema)?.applied).toEqual(['012_books_template_v2']);
    expect(await owner`SELECT id FROM ${s}.document_template_version ORDER BY id`).toEqual(versionsBefore);
  });
});

describe('013_books_assets (and 014 after it) through the fleet runner', () => {
  it('adds the asset table to a schema at 012 holding issued documents: never updated by any role, unique per company and hash', async () => {
    const tgId = assertTenantGroupId(randomUUID());
    await provisionTenant(owner, {
      ...commerceProvisionOptions(tgId, `asset-${tgId.slice(0, 8)}`),
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS.filter((m) => m.id < '013'),
    });
    const schema = tenantSchema(tgId);
    const s = owner(schema);
    // Something already there, which 013 must leave as it is.
    const tenantId = randomUUID();
    const templateId = randomUUID();
    const versionId = randomUUID();
    await owner.begin(async (tx) => {
      await tx`INSERT INTO ${tx(schema)}.document_template (id, tenant_id, name, is_default, current_version_id, updated_at)
               VALUES (${templateId}, ${tenantId}, 'Standard', true, ${versionId}, now())`;
      await tx`INSERT INTO ${tx(schema)}.document_template_version (id, tenant_id, template_id, version, document)
               VALUES (${versionId}, ${tenantId}, ${templateId}, 1, ${tx.json({ v: 2, regions: {} })})`;
    });
    const before = await owner`SELECT * FROM ${s}.document_template_version ORDER BY id`;

    // The fleet runner applies the whole set: 013, then 014 (which lets an unused logo be deleted,
    // tested on its own below).
    const result = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(result.schemas.find((x) => x.schema === schema)?.applied).toEqual(['013_books_assets', '014_books_asset_delete', '015_books_products', '016_books_subject']);
    expect(await owner`SELECT * FROM ${s}.document_template_version ORDER BY id`).toEqual(before);
    expect(await privileges(schema)).toEqual(expectedPrivileges());

    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const hash = 'ab'.repeat(32);
    const insert = (db: postgres.Sql, tenant: string, sha256: string, over: Record<string, unknown> = {}) => {
      const row = { id: randomUUID(), tenant_id: tenant, kind: 'logo', content_type: 'image/png', byte_size: png.length, sha256, width_px: 10, height_px: 10, content: png, ...over };
      return db`INSERT INTO ${db(schema)}.books_asset ${db(row)}`;
    };
    const app = postgres(ownerUrl.replace('postgres@', 'commerce_app@'), { max: 1, prepare: false, onnotice: () => {} });
    try {
      expect(await code(insert(app, tenantId, hash))).toBe('ok');
      // The same hash again for the same company is refused; for another company it is its own asset.
      expect(await code(insert(app, tenantId, hash))).toBe('23505');
      expect(await code(insert(app, randomUUID(), hash))).toBe('ok');
      // The checks: kind, type, size against the content, the hash's form, the pixel bound.
      expect(await code(insert(app, tenantId, 'cd'.repeat(32), { kind: 'favicon' }))).toBe('23514');
      expect(await code(insert(app, tenantId, 'cd'.repeat(32), { content_type: 'image/svg+xml' }))).toBe('23514');
      expect(await code(insert(app, tenantId, 'cd'.repeat(32), { byte_size: png.length + 1 }))).toBe('23514');
      expect(await code(insert(app, tenantId, 'CD'.repeat(32)))).toBe('23514');
      expect(await code(insert(app, tenantId, 'cd'.repeat(32), { width_px: 2001 }))).toBe('23514');
      expect(await code(insert(app, tenantId, 'cd'.repeat(32), { height_px: 0 }))).toBe('23514');
      // The app role never updates or truncates.
      expect(await code(app`UPDATE ${app(schema)}.books_asset SET width_px = 11 WHERE sha256 = ${hash}`)).toBe('42501');
      expect(await code(app`TRUNCATE ${app(schema)}.books_asset`)).toBe('42501');
    } finally {
      await app.end();
    }
    // ... and the trigger refuses every role, the owner included.
    expect(await code(owner`UPDATE ${s}.books_asset SET width_px = 11 WHERE sha256 = ${hash}`)).toBe('BK014');
    expect(await code(owner`TRUNCATE ${s}.books_asset`)).toBe('BK014');
    expect(await owner`SELECT count(*)::int AS n FROM ${s}.books_asset`).toEqual([{ n: 2 }]);

    // Running 013 and 014 a second time (the runner forgets it applied them) changes nothing and does not fail.
    const assetsBefore = await owner`SELECT id FROM ${s}.books_asset ORDER BY id`;
    for (const id of ['013_books_assets', '014_books_asset_delete']) {
      await owner`DELETE FROM ${s}.__tenant_db_migrations WHERE id = ${id}`;
      await owner`DELETE FROM public.tenant_migration_progress WHERE schema_name = ${schema} AND migration_id = ${id}`;
    }
    const again = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(again.schemas.find((x) => x.schema === schema)?.applied).toEqual(['013_books_assets', '014_books_asset_delete']);
    expect(await owner`SELECT id FROM ${s}.books_asset ORDER BY id`).toEqual(assetsBefore);
    expect(await privileges(schema)).toEqual(expectedPrivileges());
  });
});

describe('014_books_asset_delete through the fleet runner', () => {
  it('lets every role delete only a logo nothing uses; UPDATE and TRUNCATE stay refused; commerce_app gains DELETE, never UPDATE', async () => {
    const tgId = assertTenantGroupId(randomUUID());
    await provisionTenant(owner, {
      ...commerceProvisionOptions(tgId, `asset-del-${tgId.slice(0, 8)}`),
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS.filter((m) => m.id < '014'),
    });
    const schema = tenantSchema(tgId);
    const s = owner(schema);
    // A tenant provisioned before 014 shipped: the app role held no DELETE (013's REVOKE, re-applied
    // through the append-only list of the time). Today's provisioning code already grants it, so the
    // old state is restored by hand.
    await owner`REVOKE DELETE ON ${s}.books_asset FROM commerce_app`;
    expect((await privileges(schema)).books_asset).toEqual({ sel: true, ins: true, upd: false, del: false });

    const mine = randomUUID();
    const theirs = randomUUID();
    const h = (c: string) => c.repeat(64);
    // Y: in a columns cell of a live template's current version (in use). W: only in that
    // template's older version. Z: only in an archived template. X: only in ANOTHER company's
    // template. U: named by nothing.
    const [X, Y, Z, W, U] = [h('1'), h('2'), h('3'), h('4'), h('5')];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const logoAt = (sha256: string) => ({ type: 'logo', id: 'logo', assetSha256: sha256 });
    await owner.begin(async (tx) => {
      for (const sha256 of [X, Y, Z, W, U]) {
        await tx`INSERT INTO ${tx(schema)}.books_asset ${tx({ id: randomUUID(), tenant_id: mine, kind: 'logo', content_type: 'image/png', byte_size: png.length, sha256, width_px: 10, height_px: 10, content: png })}`;
      }
      const template = async (tenant: string, name: string, docs: unknown[], archived: boolean) => {
        const id = randomUUID();
        const versions = docs.map(() => randomUUID());
        await tx`INSERT INTO ${tx(schema)}.document_template (id, tenant_id, name, is_default, current_version_id, archived_at, updated_at)
                 VALUES (${id}, ${tenant}, ${name}, false, ${versions.at(-1)!}, ${archived ? new Date() : null}, now())`;
        for (const [i, doc] of docs.entries()) {
          await tx`INSERT INTO ${tx(schema)}.document_template_version (id, tenant_id, template_id, version, document)
                   VALUES (${versions[i]}, ${tenant}, ${id}, ${i + 1}, ${tx.json(doc as never)})`;
        }
      };
      await template(
        mine,
        'Live',
        [
          { v: 2, regions: { firstPageHeader: [logoAt(W)] } },
          { v: 2, regions: { body: [{ type: 'columns', id: 'row', cells: [{ blocks: [] }, { blocks: [logoAt(Y)] }] }] } },
        ],
        false,
      );
      await template(mine, 'Archived', [{ v: 2, regions: { firstPageHeader: [logoAt(Z)] } }], true);
      await template(theirs, 'Theirs', [{ v: 2, regions: { firstPageHeader: [logoAt(X)] } }], false);
    });

    const result = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(result.schemas.find((x) => x.schema === schema)?.applied).toEqual(['014_books_asset_delete', '015_books_products', '016_books_subject']);
    expect(await privileges(schema)).toEqual(expectedPrivileges());
    // The frozen logo of a document is found through its own index.
    const [index] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = ${schema} AND indexname = 'sales_document_tenant_id_logo_sha256_idx'`;
    expect(index.n).toBe(1);
    // ... and the function's document query can use it (scans forbidden, so the plan shows whether it may).
    const plan = await owner.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx`EXPLAIN SELECT 1 FROM ${tx(schema)}.sales_document d
                 WHERE d.tenant_id = ${mine} AND (d.template_snapshot -> 'logo' ->> 'sha256') = ${Y}`;
    });
    expect((plan as unknown as Array<Record<string, string>>).map((r) => Object.values(r)[0]).join('\n')).toContain(
      'sales_document_tenant_id_logo_sha256_idx',
    );
    const inUse = async (sha256: string) =>
      (await owner<{ u: boolean }[]>`SELECT ${s}.books_asset_in_use(${mine}, ${sha256}) AS u`)[0].u;
    expect(await Promise.all([X, Y, Z, W, U].map(inUse))).toEqual([false, true, false, false, false]);

    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    const app = postgres(ownerUrl.replace('postgres@', 'commerce_app@'), { max: 1, prepare: false, onnotice: () => {} });
    try {
      expect(await code(app`UPDATE ${app(schema)}.books_asset SET width_px = 11 WHERE sha256 = ${U}`)).toBe('42501');
      expect(await code(app`TRUNCATE ${app(schema)}.books_asset`)).toBe('42501');
      expect(await code(app`DELETE FROM ${app(schema)}.books_asset WHERE tenant_id = ${mine} AND sha256 = ${Y}`)).toBe('BK015');
      // The app role may call the definition the logo list uses.
      expect((await app<{ u: boolean }[]>`SELECT ${app(schema)}.books_asset_in_use(${mine}, ${Y}) AS u`)[0].u).toBe(true);
      for (const sha256 of [X, Z, W, U]) {
        expect(await code(app`DELETE FROM ${app(schema)}.books_asset WHERE tenant_id = ${mine} AND sha256 = ${sha256}`), sha256).toBe('ok');
      }
    } finally {
      await app.end();
    }
    expect(await code(owner`UPDATE ${s}.books_asset SET width_px = 11 WHERE sha256 = ${Y}`)).toBe('BK014');
    expect(await code(owner`TRUNCATE ${s}.books_asset`)).toBe('BK014');
    expect(await code(owner`DELETE FROM ${s}.books_asset WHERE sha256 = ${Y}`)).toBe('BK015');
    expect(await owner`SELECT sha256 FROM ${s}.books_asset ORDER BY sha256`).toEqual([{ sha256: Y }]);

    // Running 014 a second time changes nothing and does not fail; the guard and the rights hold.
    await owner`DELETE FROM ${s}.__tenant_db_migrations WHERE id = '014_books_asset_delete'`;
    await owner`DELETE FROM public.tenant_migration_progress WHERE schema_name = ${schema} AND migration_id = '014_books_asset_delete'`;
    const again = await migrateAllCommerceTenants({ connectionString: ownerUrl });
    expect(again.schemas.find((x) => x.schema === schema)?.applied).toEqual(['014_books_asset_delete']);
    expect(await code(owner`DELETE FROM ${s}.books_asset WHERE sha256 = ${Y}`)).toBe('BK015');
    expect(await privileges(schema)).toEqual(expectedPrivileges());
  });
});

// Last on purpose: it leaves a schema 012 refuses to migrate, and every fleet
// run after it (which sweeps all schemas of this container) would fail on it.
describe('012_books_template_v2 and a hand-set logo', () => {
  it('refuses to drop logo_file_id while a row holds a value (nothing is changed)', async () => {
    const tgId = assertTenantGroupId(randomUUID());
    await provisionTenant(owner, {
      ...commerceProvisionOptions(tgId, `logo-${tgId.slice(0, 8)}`),
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS.filter((m) => m.id < '012'),
    });
    const schema = tenantSchema(tgId);
    const s = owner(schema);
    await owner`INSERT INTO ${s}.document_template (id, tenant_id, name, logo_file_id, updated_at)
                VALUES (${randomUUID()}, ${randomUUID()}, 'Mit Logo', 'file-1', now())`;
    const result = await migrateAllCommerceTenants({ connectionString: ownerUrl }).catch((e: unknown) => e);
    const mine = (result as { schemas?: Array<{ schema: string; applied: string[]; error?: unknown }> }).schemas?.find((x) => x.schema === schema);
    expect(mine?.applied ?? []).not.toContain('012_books_template_v2');
    const [col] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = ${schema} AND table_name = 'document_template' AND column_name = 'logo_file_id'`;
    expect(col.n).toBe(1);
  });
});
