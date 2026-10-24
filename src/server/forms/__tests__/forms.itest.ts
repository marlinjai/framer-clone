// Form submissions against a real Postgres (pnpm test:integration): the
// 016_form_submissions table in a provisioned tenant schema, the public submit
// route end to end (host -> published site -> tg_<id>, as the low-privilege
// commerce_app role), the repository the editor view uses (newest first,
// filter, read marks, real deletes), tenant isolation, and every delete path
// the house rule asks for: the owner's single delete, the project delete, a
// company erasure by workspace, and the schema drop.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { tenantDb, type TenantGroupId } from '@marlinjai/tenant-db';

import type { CommerceDB } from '@/server/commerce/db-types';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import {
  countInSchema,
  createPublishedSite,
  openCommerceAppBase,
  openStorefrontFixtures,
  provisionCommerceTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { POST } from '@/app/api/forms/submit/route';
import { __resetFormRateLimiterForTests } from '../rateLimit';
import {
  deleteFormSubmission,
  deleteSiteSubmissions,
  deleteWorkspaceSubmissions,
  insertFormSubmission,
  listFormSubmissions,
  setFormSubmissionRead,
  summarizeForms,
  type NewFormSubmission,
} from '../repository';
import { deleteProjectSubmissions } from '../projectDelete';

let fx: StorefrontFixtures;
let appBase: Kysely<CommerceDB>;
let tgId: TenantGroupId;
let schema: string;
let appDb: Kysely<CommerceDB>;
let site: { host: string; siteId: string; workspaceId: string };

const FORM_TREE = {
  id: 'form-1',
  type: 'div',
  componentType: 'host',
  props: { [FORM_KIND_ATTR]: 'form', formName: 'Contact', successMessage: 'Thanks!' },
  children: [
    { id: 'f-name', type: 'div', componentType: 'host', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'text', name: 'name', label: 'Name', required: true } },
    { id: 'f-email', type: 'div', componentType: 'host', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'email', name: 'email', label: 'Email', required: true } },
    { id: 'send', type: 'button', componentType: 'host', props: { [FORM_KIND_ATTR]: 'form-submit', children: 'Send' } },
  ],
};

function row(over: Partial<NewFormSubmission> = {}): NewFormSubmission {
  return {
    id: randomUUID(),
    tenantId: tgId,
    workspaceId: site.workspaceId,
    siteId: site.siteId,
    pageId: 'p-contact',
    pagePath: '/kontakt',
    formId: 'form-1',
    formName: 'Contact',
    fields: [{ key: 'name', label: 'Name', type: 'text', value: 'Ana' }],
    ...over,
  };
}

beforeAll(async () => {
  fx = openStorefrontFixtures();
  appBase = openCommerceAppBase();
  const tenant = await provisionCommerceTenant(fx, 'forms');
  tgId = tenant.tgId;
  schema = tenant.schema;
  appDb = tenantDb(appBase, tgId);
  site = await createPublishedSite(fx, tgId, 'forms');
  await fx.prisma.sitePage.create({
    data: {
      siteId: site.siteId,
      workspaceId: site.workspaceId,
      tenantGroupId: tgId,
      pageId: 'p-contact',
      slug: 'kontakt',
      snapshot: { id: 'p-contact', slug: 'kontakt', metadata: { title: 'Kontakt' }, canvasNodes: {}, appComponentTree: { id: 'root', type: 'div', componentType: 'host', props: {}, children: [FORM_TREE] } },
    },
  });
});

afterAll(async () => {
  await appBase?.destroy();
  await fx?.close();
});

beforeEach(async () => {
  __resetFormRateLimiterForTests();
  await fx.owner`DELETE FROM ${fx.owner(schema)}.form_submission`;
});

describe('016_form_submissions', () => {
  it('lives in the tenant schema with no IP column, and refuses rows outside its bounds', async () => {
    const cols = await fx.owner<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = 'form_submission' ORDER BY ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'id', 'tenant_id', 'workspace_id', 'site_id', 'page_id', 'page_path', 'form_id', 'form_name', 'fields', 'read_at', 'created_at',
    ]);
    await expect(insertFormSubmission(appDb, row({ tenantId: 'not-a-uuid' }))).rejects.toThrow();
    await expect(insertFormSubmission(appDb, row({ formName: '' }))).rejects.toThrow();
    await expect(
      insertFormSubmission(appDb, row({ fields: [{ key: 'x', label: 'x', type: 'textarea', value: 'y'.repeat(70_000) }] })),
    ).rejects.toThrow();
  });

  it('the app role may read, insert, update and delete it', async () => {
    const privs = await fx.owner<{ p: string }[]>`
      SELECT privilege_type AS p FROM information_schema.role_table_grants
       WHERE table_schema = ${schema} AND table_name = 'form_submission' AND grantee = 'commerce_app' ORDER BY 1`;
    expect(privs.map((r) => r.p)).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']));
  });
});

describe('POST /api/forms/submit end to end', () => {
  const post = (body: Record<string, unknown>, host = site.host) =>
    POST(
      new Request(`https://${host}/api/forms/submit`, {
        method: 'POST',
        headers: { host, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200)}` },
        body: JSON.stringify(body),
      }),
    );

  it('stores a valid submission in the site company schema, once per submission id', async () => {
    const submissionId = randomUUID();
    const body = { formId: 'form-1', values: { name: 'Ana', email: 'ana@example.com' }, elapsedMs: 9000, submissionId };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, message: 'Thanks!' });
    expect((await post(body)).status).toBe(200);
    const rows = await fx.owner`SELECT * FROM ${fx.owner(schema)}.form_submission`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: submissionId, site_id: site.siteId, workspace_id: site.workspaceId, page_path: '/kontakt', form_name: 'Contact' });
    expect(rows[0].fields).toEqual([
      { key: 'name', label: 'Name', type: 'text', value: 'Ana' },
      { key: 'email', label: 'Email', type: 'email', value: 'ana@example.com' },
    ]);
    expect(JSON.stringify(rows[0])).not.toMatch(/198\.51\.100/);
  });

  it('refuses invalid values and stores nothing; an unknown host is no storefront', async () => {
    const res = await post({ formId: 'form-1', values: { name: '', email: 'x' }, elapsedMs: 9000 });
    expect(res.status).toBe(422);
    expect((await post({ formId: 'form-1', values: { name: 'A', email: 'a@b.de' }, elapsedMs: 9000 }, 'nobody-here.example.com')).status).toBe(403);
    expect(await countInSchema(fx, schema, 'form_submission')).toBe(0);
  });
});

describe('the repository behind the submissions view', () => {
  it('lists newest first with a cursor, filters by form, summarizes, marks read and deletes for real', async () => {
    const base = Date.parse('2026-10-24T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      await insertFormSubmission(appDb, row({ id: `s${i}`, formId: i % 2 ? 'form-b' : 'form-1', formName: i % 2 ? 'Booking' : 'Contact' }));
      await fx.owner`UPDATE ${fx.owner(schema)}.form_submission SET created_at = ${new Date(base + i * 1000)} WHERE id = ${`s${i}`}`;
    }
    const ref = { tenantId: tgId, siteId: site.siteId };
    const first = await listFormSubmissions(appDb, ref, { limit: 2 });
    expect(first.submissions.map((s) => s.id)).toEqual(['s4', 's3']);
    expect(first.hasMore).toBe(true);
    const last = first.submissions[1];
    const second = await listFormSubmissions(appDb, ref, { limit: 2, before: { createdAt: last.createdAt, id: last.id } });
    expect(second.submissions.map((s) => s.id)).toEqual(['s2', 's1']);
    expect((await listFormSubmissions(appDb, ref, { formId: 'form-b' })).submissions.map((s) => s.id)).toEqual(['s3', 's1']);

    expect(await setFormSubmissionRead(appDb, ref, 's4', true)).toBe(true);
    expect((await listFormSubmissions(appDb, ref, { limit: 1 })).submissions[0].readAt).toBeInstanceOf(Date);
    expect(await summarizeForms(appDb, ref)).toEqual([
      { formId: 'form-b', formName: 'Booking', total: 2, unread: 2 },
      { formId: 'form-1', formName: 'Contact', total: 3, unread: 2 },
    ]);
    expect(await setFormSubmissionRead(appDb, ref, 's4', false)).toBe(true);

    expect(await deleteFormSubmission(appDb, ref, 's4')).toBe(true);
    expect(await deleteFormSubmission(appDb, ref, 's4')).toBe(false);
    const gone = await fx.owner`SELECT 1 FROM ${fx.owner(schema)}.form_submission WHERE id = 's4'`;
    expect(gone).toHaveLength(0);
  });

  it("another site's row in the same schema answers not found, never changes", async () => {
    await insertFormSubmission(appDb, row({ id: 'foreign', siteId: 'other-site' }));
    const ref = { tenantId: tgId, siteId: site.siteId };
    expect(await setFormSubmissionRead(appDb, ref, 'foreign', true)).toBe(false);
    expect(await deleteFormSubmission(appDb, ref, 'foreign')).toBe(false);
    expect((await listFormSubmissions(appDb, ref)).submissions).toHaveLength(0);
  });
});

describe('deletion and erasure', () => {
  it('the project delete removes exactly that project rows', async () => {
    await insertFormSubmission(appDb, row());
    await insertFormSubmission(appDb, row());
    await insertFormSubmission(appDb, row({ siteId: 'other-site' }));
    expect(await deleteProjectSubmissions(tgId, site.siteId)).toBe(2);
    expect(await countInSchema(fx, schema, 'form_submission')).toBe(1);
    // A legacy site without a commerce schema has nothing to delete.
    expect(await deleteProjectSubmissions('not-a-tenant-group', site.siteId)).toBe(0);
  });

  it('a company erasure by workspace removes its rows and leaves other workspaces', async () => {
    await insertFormSubmission(appDb, row());
    await insertFormSubmission(appDb, row({ workspaceId: 'ws-other' }));
    expect(await deleteWorkspaceSubmissions(appDb, { tenantId: tgId, workspaceId: site.workspaceId })).toBe(1);
    expect(await deleteSiteSubmissions(appDb, { tenantId: tgId, siteId: site.siteId })).toBe(1);
    expect(await countInSchema(fx, schema, 'form_submission')).toBe(0);
  });

  it('dropping the tenant schema takes every submission with it', async () => {
    const other = await provisionCommerceTenant(fx, 'forms-drop');
    const db = tenantDb(appBase, other.tgId);
    await insertFormSubmission(db, row({ tenantId: other.tgId }));
    expect(await countInSchema(fx, other.schema, 'form_submission')).toBe(1);
    await fx.owner`DROP SCHEMA ${fx.owner(other.schema)} CASCADE`;
    const left = await fx.owner`SELECT 1 FROM information_schema.tables WHERE table_schema = ${other.schema}`;
    expect(left).toHaveLength(0);
    // The first tenant is untouched.
    expect(await countInSchema(fx, schema, 'form_submission')).toBe(0);
  });
});
